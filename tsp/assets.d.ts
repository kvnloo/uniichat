// Bun embeds this existing native helper as text during the terminal bundle.
declare module "*.swift" {
  const source: string;
  export default source;
}
