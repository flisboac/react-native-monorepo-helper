# react-native-monorepo-helper

A helper library that makes React Native development in monorepo projects easier.

If you're having problems with Metro/Haste not finding your files and/or 
dependencies, or that your `nohoist` config is becoming a bit unwieldly,
this tool can help you out! It'll provide a `CustomResolver` and setup 
project roots and watch folders for your `rn-cli.config.js`. TypeScript
configuration automation is also optionally provided. 

P.S.: The tool itself is developed in TypeScript, so no need for a `@types`
package, fellow TypeScript programmers! :)


## Installation

For NPM users:

```sh
npm install --save-dev react-native-monorepo-helper
```

For Yarn users:

```sh
yarn add --dev react-native-monorepo-helper
```

## Usage

Considering a project with a structure similar to the following:

```
myproj/
├── package.json
├── node_modules/
└── packages/
    ├── myproj-react-native-app/
    │   ├── node_modules/
    │   │   └── react-native/
    │   ├── android/
    │   ├── ios/
    │   ├── index.js
    │   ├── package.json
    │   └── rn-cli.config.js
    └── myproj-lib
        ├── index.js
        └── package.json
```

First, be sure to `nohoist` React Native and any dependency that needs to be
`react-native link`ed. You can either use Lerna or Yarn Workspaces to configure
your monorepo project.

In your `rn-cli.config.js`:

```js
const projectRoot = __dirname;
const metroConfig = require('react-native-monorepo-helper').default;

module.exports = metroConfig(projectRoot);
```

Optionally, you can use a configuration helper, and tweak the options for your
needs, e.g. setting up TypeScript:

```js
const projectRoot = __dirname;
const metroConfigHelper = require('react-native-monorepo-helper') 
    .metroConfigHelper;

module.exports = metroConfigHelper(projectRoot)
    .typeScript(true)
    .watchFolder("external/folder/a", "external/folder/b")
    .defaultConfig({
        // Documentation: https://facebook.github.io/metro/docs/en/configuration
        port: 9091
    })
    .generate();
```


## License

MIT.
