declare module '*.csv?raw' {
  const content: string;
  export default content;
}

declare module '*.jsonl?raw' {
  const content: string;
  export default content;
}
