declare module 'virtual:tendril-migrations' {
  const migrations: { version: number; name: string; sql: string }[];
  export default migrations;
}
