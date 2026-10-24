import type { NextConfig } from "next"

const config: NextConfig = {
  devIndicators: false,
  // PGlite ships Postgres as WebAssembly and data files; load it from node_modules as is.
  serverExternalPackages: ["@electric-sql/pglite"],
}

export default config
