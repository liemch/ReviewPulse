import { healthResponse } from "./health";

/** Liveness — process is up (no dependency checks). */
export async function GET() {
  return healthResponse();
}
