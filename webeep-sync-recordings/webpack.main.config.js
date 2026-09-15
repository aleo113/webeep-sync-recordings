const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");
const assets = ["icons", "locales"];

module.exports = {
    /**
     * This is the main entry point for your application, it's the first file
     * that runs in the main process.
     */
    entry: "./src/index.ts",
    // Put your normal webpack config below here
    target: "electron-main",
    module: {
        rules: require("./webpack.rules"),
    },
    resolve: {
        // Match the CommonJS imports emitted by ts-loader. The backend's ESM
        // entry uses top-level await and cannot be consumed by those imports.
        alias: { "i18next-fs-backend$": require.resolve("i18next-fs-backend") },
        extensions: [".js", ".ts", ".jsx", ".tsx", ".css", ".json", "scss"],
    },
    plugins: [
        new CopyPlugin({
            patterns: assets.map((a) => {
                return {
                    from: path.join(__dirname, "static", a),
                    to: path.join(__dirname, ".webpack/main/static", a),
                };
            }),
        }),
    ],
};
