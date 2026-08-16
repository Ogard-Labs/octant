import { assertSqliteConformance } from "./sqlitePort.conformance.ts";
import { openSqlite } from "./sqlitePort.ts";

assertSqliteConformance(openSqlite);
console.log("Octant SQLite port smoke passed");
