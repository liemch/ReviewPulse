import { checkDatabaseConnectivity } from "@reviewpulse/db";
import { readyResponse } from "./ready";

/** Readiness — fails closed if PostgreSQL is unreachable. */
export async function GET() {
  const databaseOk = await checkDatabaseConnectivity();
  return readyResponse(databaseOk);
}
