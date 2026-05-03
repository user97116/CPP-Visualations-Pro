const path = require('path');

/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node', // VS Code extensions run in a Node.js-like environment
  mode: 'none', // Set to 'development' or 'production'
  entry: './src/extension.ts', // Entry point of your extension
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },
  devtool: 'source-map',
  externals: {
    vscode: 'commonjs vscode', // The vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed.
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
          },
        ],
      },
    ],
  },
};

module.exports = [extensionConfig];
