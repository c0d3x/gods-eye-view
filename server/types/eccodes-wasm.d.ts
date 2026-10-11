// The server type-check reads no JavaScript from node_modules
// (maxNodeModuleJsDepth 0 in server/jsconfig.json): electron-builder brings
// in the npm `string_decoder` package, which would otherwise shadow Node's own
// module of that name. eccodes-wasm ships no types, so it is declared here.
declare module '@meri-imperiumi/eccodes-wasm';
