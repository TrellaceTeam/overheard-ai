import { PGlite } from "@electric-sql/pglite";
const db = await PGlite.create();
const v = await db.query("select version() as v");
console.log("node", process.version);
console.log(v.rows[0].v);
const g = await db.query(
  "select gen_random_uuid() as u, stddev_pop(x) as sd from (values (1),(2),(3)) t(x)",
);
console.log(JSON.stringify(g.rows[0]));
const f = await db.query(
  "select count(*) filter (where x > 1) as c from (values (1),(2),(3)) t(x)",
);
console.log("filter clause ok:", JSON.stringify(f.rows[0]));
await db.close();
