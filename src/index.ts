
import path from 'path';
import fs from 'fs';
import resolve from 'resolve';
import glob from 'glob';

export interface Logger {
    debug: (...args: any[]) => any
    error: (...args: any[]) => any
}

export namespace Metro {

    export enum ResolutionType {
        ASSET = 'asset',
        SOURCE_FILE = 'sourceFile'
    }

    export type CustomResolver = (metro: ResolverConfig, moduleName: string, platform: string) => Resolution | null;

    export interface Resolution {
        type: ResolutionType;
        filePath: string;
    }

    export interface Config {
        watchFolders: string[];
        resolver: {
            resolveRequest?: CustomResolver;
            extraNodeModules?: { [moduleName: string]: string };
        };
        sourceExts?: string[];
        getTransformModulePath?: () => any;
    }

    export interface ResolverConfig {
        originModulePath: string;
        sourceExts: string[];
        assetExts?: string[];
        mainFields: string[];
    }
}

export interface MonorepoInfo {
    root: string;
    nodeModulesRoot: string;
    project: {
        root: string;
        nodeModulesRoot: string;
    };
    packages: { root: string, nodeModulesRoot: string }[],
}

interface ResolverContext {
    metro: Metro.ResolverConfig;
    moduleName: string;
    platform: string;
}

type MonorepoFinder = (projectRoot: string, helper: MetroConfigHelper) => MonorepoInfo | null

interface MetroConfigHelperOptions {
    logger?: Logger,
    defaultConfig?: Partial<Metro.Config>,
    monorepoFinders?: MonorepoFinder[];
    projectRoot?: string
}

interface TypeScriptConfig {
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
    for (let packageName of globs) {
        if (typeof packageName !== 'string') continue;
        results = results.concat(glob.sync(packageName, { cwd }));
    }
    return results;
}

function unique(array: string[]) {
    return array.filter((value, index, self) => self.indexOf(value) === index)
}

class MetroConfigHelper {

    private monorepoFinders_: MonorepoFinder[];

    private logger_: Logger;
    private defaultConfig_?: Partial<Metro.Config>;
    private monorepo_?: MonorepoInfo;
    private projectRoot_?: string;
    private watchFolders_: string[];
    private customResolver_?: Metro.CustomResolver;
    private config_?: Metro.Config;
    private typeScript_: false | TypeScriptConfig;

    constructor(options?: MetroConfigHelperOptions) {
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

    projectRoot(): string;
    projectRoot(newProjectRoot: string): this;
    projectRoot(newProjectRoot?: string) {
        if (newProjectRoot) {
            this.projectRoot_ = newProjectRoot;
            return this;
        }
        if (!this.projectRoot_) throw new Error("Project's root folder not set.");
        return this.projectRoot_;
    }

    monorepoFinder(...finder: MonorepoFinder[]) {
        this.monorepoFinders_ = this.monorepoFinders_.concat(
            finder.filter(f => typeof f === 'function')
        );
        return this;
    }

    findMonorepo() {
        for (let monorepoFinder of this.monorepoFinders_) {
            let monorepo = monorepoFinder(this.projectRoot(), this);
            if (monorepo) return monorepo;
        }
        return undefined;
    }

    logger(): Logger;
    logger(newLogger: Logger): this;
    logger(newLogger?: Logger) {
        if (newLogger) {
            this.logger_ = newLogger;
            return this;
        }
        if (!this.logger_) throw new Error("Logger not set.");
        return this.logger_;
    }

    defaultConfig(): Partial<Metro.Config>;
    defaultConfig(newDefaultConfig: Partial<Metro.Config>): this;
    defaultConfig(newDefaultConfig?: Partial<Metro.Config>) {
        if (newDefaultConfig) {
            this.defaultConfig_ = newDefaultConfig;
            return this;
        }
        if (!this.defaultConfig_) throw new Error("Default config not set.");
        return this.defaultConfig_;
    }

    monorepo(): MonorepoInfo;
    monorepo(newMonorepoInfo: MonorepoInfo): this;
    monorepo(newMonorepoInfo?: MonorepoInfo) {
        if (newMonorepoInfo) {
            this.monorepo_ = newMonorepoInfo;
            return this;
        } else if (!this.monorepo_) {
            this.monorepo_ = this.findMonorepo();
        }
        if (!this.monorepo_) throw new Error("Monorepo not set.");
        return this.monorepo_;
    }

    typeScript(): false | TypeScriptConfig;
    typeScript(enabled: boolean | string | Partial<TypeScriptConfig>): this;
    typeScript(enabled?: boolean | string | Partial<TypeScriptConfig>) {
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

    watchFolder(...folder: string[]) {
        this.watchFolders_ = this.watchFolders_.concat(folder);
        return this;
    }

    packageRoots() {
        return this.monorepo().packages.map(packageInfo => packageInfo.root);
    }

    watchFolders() {
        return unique([
            this.monorepo().root,
            ...this.packageRoots(),
            ...this.watchFolders_,
        ]);
    }

    customResolver(): Metro.CustomResolver;
    customResolver(newResolver: Metro.CustomResolver): this;
    customResolver(newResolver?: Metro.CustomResolver) {
        if (newResolver) {
            this.customResolver_ = newResolver;
            return this;
        } else if (!this.customResolver_) {
            this.customResolver_ = this.createCustomResolver();
        }
        if (!this.customResolver_) throw new Error("Custom resolver not set.");
        return this.customResolver_;
    }

    createCustomResolver(): Metro.CustomResolver {
        return (metro, moduleName, platform) => {
            const context: ResolverContext = {
                metro,
                platform,
                moduleName
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

    private resolveInProject(context: ResolverContext, projectRoot: string, type: Metro.ResolutionType, extensions: string[]) {
        const originModulePath = context.metro.originModulePath;
        const basedir = path.dirname(originModulePath);
        const packageJson = path.resolve(projectRoot, 'package.json');
        const moduleName = context.moduleName;
        const paths = this.packageRoots();
        extensions = this.generateComplementaryExtensions(context, extensions);

        let resolvedName: string | undefined;

        if (moduleName.startsWith('./') || moduleName.startsWith('../')) {
            for (let extension of extensions) {
                const pathname = `${path.resolve(basedir, moduleName)}.${extension}`;

                if (fs.existsSync(pathname)) {
                    let stat = fs.lstatSync(pathname);

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
                    package: packageJson,
                    extensions,
                    paths,
                });

            } catch (error) {}
        }

        if (resolvedName) {
            return { type, filePath: resolvedName };
        }

        return undefined;
    }

    private generateComplementaryExtensions(context: ResolverContext, baseExtensions: string[]) {
        let filePaths: string[] = [];
        for (let baseExt of baseExtensions) {
            filePaths = filePaths.concat([
                `${baseExt}`,
                `${context.platform}.${baseExt}`,
            ])
        }
        return filePaths;
    }

    config(): Metro.Config;
    config(newConfig: Metro.Config): this;
    config(newConfig?: Metro.Config) {
        if (newConfig) {
            this.config_ = newConfig;
            return this;
        } else if (!this.config_) {
            this.config_ = this.generate();
        }
        if (!this.config_) throw new Error("Custom resolver not set.");
        return this.config_;
    }

    generate() {
        const config: Metro.Config = {
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

    readonly mapByFolderFollowingSymlink = (path: string) => {
        let stat = fs.existsSync(path) ? fs.statSync(path) : null;
        if (stat && stat.isSymbolicLink()) {
            path = fs.realpathSync(path);
            stat = fs.existsSync(path) ? fs.statSync(path) : null;
        }
        if (stat && stat.isDirectory()) return path;
        return '';
    }

    readonly filterByNonEmptyString = (path: any) => {
        return typeof path === 'string' && !!path;
    }

    private isTypeScriptConfig(value: any): value is TypeScriptConfig {
        return typeof value === 'object' && value !== null;
    }
}


export function findLernaMonorepo(projectRoot: string, helper: MetroConfigHelper): MonorepoInfo | null {
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
    helper.logger().debug(`Found lerna monorepo.`, info);
    return info;
}

export function findYarnMonorepo(projectRoot: string, helper: MetroConfigHelper): MonorepoInfo | null {
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

export const nullLogger: Logger = {
    debug: () => {},
    error: () => {},
}

export const defaultTypeScriptConfig: TypeScriptConfig = {
    fileExtensions: ["ts", "tsx"],
    transformerModuleName: "react-native-typescript-transformer"
}

export function metroConfigHelper(projectRoot: string, options?: MetroConfigHelperOptions) {
    return new MetroConfigHelper(options || defaultHelperOptions)
        .projectRoot(projectRoot);
}

export function metroConfig(projectRoot: string) {
    return metroConfigHelper(projectRoot).generate();
}

export default metroConfig;
