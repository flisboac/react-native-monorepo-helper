
import fs from 'fs';
import glob from 'glob';
import path from 'path';
import resolve from 'resolve';

export interface ILogger {
    debug: (...args: any[]) => any
    error: (...args: any[]) => any
}

export namespace Metro {

    export enum ResolutionType {
        ASSET = 'asset',
        SOURCE_FILE = 'sourceFile'
    }

    export type CustomResolver = (metro: IResolverConfig, moduleName: string, platform: string) => IResolution | null;

    export interface IResolution {
        type: ResolutionType;
        filePath: string;
    }

    export interface IConfig {
        watchFolders: string[];
        resolver: {
            resolveRequest?: CustomResolver;
            extraNodeModules?: { [moduleName: string]: string };
        };
        sourceExts?: string[];
        getTransformModulePath?: () => any;
    }

    export interface IResolverConfig {
        originModulePath: string;
        sourceExts: string[];
        assetExts?: string[];
        mainFields: string[];
    }
}

export interface IMonorepoInfo {
    root: string;
    nodeModulesRoot: string;
    project: {
        root: string;
        nodeModulesRoot: string;
    };
    packages: Array<{ root: string, nodeModulesRoot: string }>,
}

interface IResolverContext {
    metro: Metro.IResolverConfig;
    moduleName: string;
    platform: string;
}

type FMonorepoFinder = (projectRoot: string, helper: MetroConfigHelper) => IMonorepoInfo | null

interface IMetroConfigHelperOptions {
    logger?: ILogger,
    defaultConfig?: Partial<Metro.IConfig>,
    monorepoFinders?: FMonorepoFinder[];
    projectRoot?: string
}

interface ITypeScriptConfig {
    transformerModuleName: string;
    fileExtensions: string[];
}

// ---


function tryParseJsonFile<T extends object = any>(filename: string) {
    if (fs.existsSync(filename)) {
        const jsonFile = fs.readFileSync(filename);
        const json = JSON.parse(jsonFile.toString());
        if (typeof json === 'object') return json as T;
    }
    return undefined;
}

function readPackageGlobs(globs: any[], cwd: string) {
    let results: string[] = [];
    for (const packageName of globs) {
        if (typeof packageName !== 'string') continue;
        results = results.concat(glob.sync(packageName, { cwd }));
    }
    return results;
}

function unique(array: string[]) {
    return array.filter((value, index, self) => self.indexOf(value) === index)
}

class MetroConfigHelper {

    private monorepoFinders_: FMonorepoFinder[];

    private logger_: ILogger;
    private defaultConfig_?: Partial<Metro.IConfig>;
    private monorepo_?: IMonorepoInfo;
    private projectRoot_?: string;
    private watchFolders_: string[];
    private customResolver_?: Metro.CustomResolver;
    private config_?: Metro.IConfig;
    private typeScript_: false | ITypeScriptConfig;

    public constructor(options?: IMetroConfigHelperOptions) {
        options = options || {};
        this.logger_ = options.logger || console;
        this.defaultConfig_ = options.defaultConfig || {};
        this.monorepoFinders_ = [];
        this.projectRoot_ = options.projectRoot;
        this.watchFolders_ = [];
        this.watchFolders_ = [];
        this.typeScript_ = false;

        this.monorepoFinder(...(options.monorepoFinders || []));
    }

    public projectRoot(): string;
    public projectRoot(newProjectRoot: string): this;
    public projectRoot(newProjectRoot?: string) {
        if (newProjectRoot) {
            this.projectRoot_ = newProjectRoot;
            return this;
        }
        if (!this.projectRoot_) throw new Error("Project's root folder not set.");
        return this.projectRoot_;
    }

    public monorepoFinder(...finder: FMonorepoFinder[]) {
        this.monorepoFinders_ = this.monorepoFinders_.concat(
            finder.filter(f => typeof f === 'function')
        );
        return this;
    }

    public findMonorepo() {
        for (const monorepoFinder of this.monorepoFinders_) {
            const monorepo = monorepoFinder(this.projectRoot(), this);
            if (monorepo) return monorepo;
        }
        return undefined;
    }

    public logger(): ILogger;
    public logger(newLogger: ILogger): this;
    public logger(newLogger?: ILogger) {
        if (newLogger) {
            this.logger_ = newLogger;
            return this;
        }
        if (!this.logger_) throw new Error("Logger not set.");
        return this.logger_;
    }

    public defaultConfig(): Partial<Metro.IConfig>;
    public defaultConfig(newDefaultConfig: Partial<Metro.IConfig>): this;
    public defaultConfig(newDefaultConfig?: Partial<Metro.IConfig>) {
        if (newDefaultConfig) {
            this.defaultConfig_ = newDefaultConfig;
            return this;
        }
        if (!this.defaultConfig_) throw new Error("Default config not set.");
        return this.defaultConfig_;
    }

    public monorepo(): IMonorepoInfo;
    public monorepo(newMonorepoInfo: IMonorepoInfo): this;
    public monorepo(newMonorepoInfo?: IMonorepoInfo) {
        if (newMonorepoInfo) {
            this.monorepo_ = newMonorepoInfo;
            return this;
        } else if (!this.monorepo_) {
            this.monorepo_ = this.findMonorepo();
        }
        if (!this.monorepo_) throw new Error("Monorepo not set.");
        return this.monorepo_;
    }

    public typeScript(): false | ITypeScriptConfig;
    public typeScript(enabled: boolean | string | Partial<ITypeScriptConfig>): this;
    public typeScript(enabled?: boolean | string | Partial<ITypeScriptConfig>) {
        if (enabled === true) {
            this.typeScript_ = defaultTypeScriptConfig;
            return this;
        } else if (typeof enabled === "string") {
            if (!enabled) throw new Error("Transformer module name cannot be empty.");
            this.typeScript_ = {
                ...defaultTypeScriptConfig,
                transformerModuleName: enabled,
            };
            return this;
        } else if (typeof enabled === "object" && enabled !== null) {
            this.typeScript_ = {
                ...defaultTypeScriptConfig,
                ...enabled
            };
        }
        return this.typeScript_;
    }

    public watchFolder(...folder: string[]) {
        this.watchFolders_ = this.watchFolders_.concat(folder);
        return this;
    }

    public packageRoots() {
        return this.monorepo().packages.map(packageInfo => packageInfo.root);
    }

    public watchFolders() {
        return unique([
            this.monorepo().root,
            ...this.packageRoots(),
            ...this.watchFolders_,
        ]);
    }

    public customResolver(): Metro.CustomResolver;
    public customResolver(newResolver: Metro.CustomResolver): this;
    public customResolver(newResolver?: Metro.CustomResolver) {
        if (newResolver) {
            this.customResolver_ = newResolver;
            return this;
        } else if (!this.customResolver_) {
            this.customResolver_ = this.createCustomResolver();
        }
        if (!this.customResolver_) throw new Error("Custom resolver not set.");
        return this.customResolver_;
    }

    public createCustomResolver(): Metro.CustomResolver {
        return (metro, moduleName, platform) => {
            const context: IResolverContext = {
                metro,
                moduleName,
                platform,
            }

            const sourceExts = context.metro.sourceExts;
            const assetExts = context.metro.assetExts || [];
            const projectRoot = this.monorepo().project.root;
            const monorepoRoot = this.monorepo().root;

            const resolution =
                this.resolveInProject(context, projectRoot, Metro.ResolutionType.SOURCE_FILE, sourceExts)
                || this.resolveInProject(context, projectRoot, Metro.ResolutionType.ASSET, assetExts)
                || this.resolveInProject(context, monorepoRoot, Metro.ResolutionType.SOURCE_FILE, sourceExts)
                || this.resolveInProject(context, monorepoRoot, Metro.ResolutionType.ASSET, assetExts)
                || null;

            return resolution;
        }
    }

    public config(): Metro.IConfig;
    public config(newConfig: Metro.IConfig): this;
    public config(newConfig?: Metro.IConfig) {
        if (newConfig) {
            this.config_ = newConfig;
            return this;
        } else if (!this.config_) {
            this.config_ = this.generate();
        }
        if (!this.config_) throw new Error("Custom resolver not set.");
        return this.config_;
    }

    public generate() {
        const config: Metro.IConfig = {
            ...this.defaultConfig(),
            watchFolders: [
                ...(this.defaultConfig().watchFolders || []),
                ...this.watchFolders()
                    .map(this.mapByFolderFollowingSymlink)
                    .filter(this.filterByNonEmptyString),
                ],
            resolver: {
                ...(this.defaultConfig().resolver || {}),
                resolveRequest: this.customResolver(),
            },
        }

        const typeScript = this.typeScript();

        if (this.isTypeScriptConfig(typeScript)) {
            config.getTransformModulePath =
                config.getTransformModulePath
                || (() => require.resolve(typeScript.transformerModuleName));
            config.sourceExts = [
                ...(config.sourceExts || []),
                ...typeScript.fileExtensions,
            ];
        }

        return config;
    }

    private readonly mapByFolderFollowingSymlink = (pathname: string) => {
        let stat = fs.existsSync(pathname) ? fs.statSync(pathname) : null;
        if (stat && stat.isSymbolicLink()) {
            pathname = fs.realpathSync(pathname);
            stat = fs.existsSync(pathname) ? fs.statSync(pathname) : null;
        }
        if (stat && stat.isDirectory()) return pathname;
        return '';
    }

    private readonly filterByNonEmptyString = (pathname: any) => {
        return typeof pathname === 'string' && !!pathname;
    }

    private resolveInProject(context: IResolverContext, projectRoot: string, type: Metro.ResolutionType, extensions: string[]) {
        const originModulePath = context.metro.originModulePath;
        const basedir = path.dirname(originModulePath);
        const packageJson = path.resolve(projectRoot, 'package.json');
        const moduleName = context.moduleName;
        const paths = this.packageRoots();
        extensions = this.generateComplementaryExtensions(context, extensions);

        let resolvedName: string | undefined;

        if (moduleName.startsWith('./') || moduleName.startsWith('../')) {
            for (const extension of extensions) {
                const pathname = `${path.resolve(basedir, moduleName)}.${extension}`;

                if (fs.existsSync(pathname)) {
                    const stat = fs.lstatSync(pathname);

                    if (stat.isFile() || stat.isFIFO()) {
                        resolvedName = pathname;
                        break;
                    }
                }
            }
        }

        if (!resolvedName) {
            try {
                resolvedName = resolve.sync(context.moduleName, {
                    basedir,
                    extensions,
                    package: packageJson,
                    paths,
                });

            } catch (error) {}
        }

        if (resolvedName) {
            return { type, filePath: resolvedName };
        }

        return undefined;
    }

    private generateComplementaryExtensions(context: IResolverContext, baseExtensions: string[]) {
        let filePaths: string[] = [];
        for (const baseExt of baseExtensions) {
            filePaths = filePaths.concat([
                `${baseExt}`,
                `${context.platform}.${baseExt}`,
            ])
        }
        return filePaths;
    }

    private isTypeScriptConfig(value: any): value is ITypeScriptConfig {
        return typeof value === 'object' && value !== null;
    }
}


export function findLernaMonorepo(projectRoot: string, helper: MetroConfigHelper): IMonorepoInfo | null {
    let packageRoots: string[] = [];

    let found = false;
    let monorepoRoot = projectRoot;
    while (true) {
        helper.logger().debug(`Searching for lerna monorepo at '${monorepoRoot}'...`);
        const lernaJsonFilename = path.resolve(monorepoRoot, "lerna.json");
        const lernaJson = tryParseJsonFile(lernaJsonFilename);

        if (lernaJson) {
            found = true;

            if (lernaJson.useWorkspaces === true && lernaJson.npmClient === 'yarn') {
                const packageJsonFilename = path.resolve(monorepoRoot, "package.json");
                const packageJson = tryParseJsonFile(packageJsonFilename);

                if (packageJson) {
                    const workspaces = packageJson.workspaces;

                    if (workspaces instanceof Array) {
                        packageRoots = packageRoots.concat(readPackageGlobs(workspaces, monorepoRoot));

                    } else if (typeof workspaces === 'object' && workspaces.packages instanceof Array) {
                        packageRoots = packageRoots.concat(readPackageGlobs(workspaces.packages, monorepoRoot));
                    }
                }

            } else if (lernaJson.packages instanceof Array) {
                packageRoots = packageRoots.concat(readPackageGlobs(lernaJson.packages, monorepoRoot));
            }
        }

        if (found) break;
        monorepoRoot = path.dirname(monorepoRoot);
        if (path.parse(monorepoRoot).root === monorepoRoot) break;
    }

    if (!found) {
        helper.logger().debug(`Could not find lerna monorepo starting at project root '${projectRoot}'.`);
        return null;
    }

    const info = {
        nodeModulesRoot: path.resolve(monorepoRoot, 'node_modules'),
        packages:
            packageRoots.map(root => ({
                nodeModulesRoot: path.resolve(monorepoRoot, root, 'node_modules'),
                root: path.resolve(monorepoRoot, root),
            })),
        project: {
            nodeModulesRoot: path.resolve(projectRoot, 'node_modules'),
            root: projectRoot,
        },
        root: monorepoRoot,
    };
    helper.logger().debug(`Found lerna monorepo.`, info);
    return info;
}

export function findYarnMonorepo(projectRoot: string, helper: MetroConfigHelper): IMonorepoInfo | null {
    let packageRoots: string[] = [];
    let found = false;
    let monorepoRoot = projectRoot;

    while (true) {
        helper.logger().debug(`Searching for yarn monorepo at '${monorepoRoot}'...`);
        const packageJsonFilename = path.resolve(monorepoRoot, "package.json");
        const packageJson = tryParseJsonFile(packageJsonFilename);

        if (packageJson) {
            found = true;
            const workspaces = packageJson.workspaces;

            if (workspaces instanceof Array) {
                packageRoots = packageRoots.concat(readPackageGlobs(workspaces, monorepoRoot));

            } else if (typeof workspaces === 'object' && workspaces.packages instanceof Array) {
                packageRoots = packageRoots.concat(readPackageGlobs(workspaces.packages, monorepoRoot));
            }
        }

        if (found) break;
        monorepoRoot = path.dirname(monorepoRoot);
        if (path.parse(monorepoRoot).root === monorepoRoot) break;
    }

    if (!found) {
        helper.logger().debug(`Could not find lerna monorepo starting at project root '${projectRoot}'.`);
        return null;
    }

    const info = {
        root: monorepoRoot,
        nodeModulesRoot: path.resolve(monorepoRoot, 'node_modules'),
        packages:
            packageRoots.map(root => ({
                root: path.resolve(monorepoRoot, root),
                nodeModulesRoot: path.resolve(monorepoRoot, root, 'node_modules')
            })),
        project: {
            root: projectRoot,
            nodeModulesRoot: path.resolve(projectRoot, 'node_modules')
        }
    };
    helper.logger().debug(`Found yarn monorepo.`, info);
    return info;
}

export const defaultHelperOptions = {
    logger: console,
    monorepoFinders: [findLernaMonorepo, findYarnMonorepo]
}

export const nullLogger: ILogger = {
    debug: () => {},
    error: () => {},
}

export const defaultTypeScriptConfig: ITypeScriptConfig = {
    fileExtensions: ["ts", "tsx"],
    transformerModuleName: "react-native-typescript-transformer"
}

export function metroConfigHelper(projectRoot: string, options?: IMetroConfigHelperOptions) {
    return new MetroConfigHelper(options || defaultHelperOptions)
        .projectRoot(projectRoot);
}

export function metroConfig(projectRoot: string) {
    return metroConfigHelper(projectRoot).generate();
}

export default metroConfig;
