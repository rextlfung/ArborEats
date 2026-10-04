// Overture Maps places: an open dataset that merges Meta, Microsoft, Foursquare
// and other providers. Queried straight from its public S3 bucket with DuckDB;
// no account or key needed.
import { DuckDBInstance } from "@duckdb/node-api";

const CATALOG = "https://stac.overturemaps.org/catalog.json";

export async function fetchOverturePlaces([south, west, north, east]) {
  const { latest } = await (await fetch(CATALOG, { signal: AbortSignal.timeout(30000) })).json();
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  await conn.run("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';");
  const result = await conn.runAndReadAll(`
    SELECT id, names.primary AS name, taxonomy.hierarchy AS hierarchy, confidence, operating_status,
           websites, socials, phones, addresses[1].freeform AS address,
           bbox.xmin AS lon, bbox.ymin AS lat,
           list_distinct(list_transform(sources, s -> s.dataset)) AS datasets
    FROM read_parquet('s3://overturemaps-us-west-2/release/${latest}/theme=places/type=place/*', hive_partitioning=1)
    WHERE bbox.xmin BETWEEN ${west} AND ${east} AND bbox.ymin BETWEEN ${south} AND ${north}
      AND list_contains(taxonomy.hierarchy, 'food_and_drink')`);
  return { release: latest, places: result.getRowObjectsJson() };
}
