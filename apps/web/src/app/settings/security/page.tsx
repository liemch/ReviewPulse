import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SettingsShell } from "../_components/shell";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

export default async function SecuritySettingsPage() {
  const services = getServices();
  const jar = await cookies();
  const csrf = jar.get(services.policy.csrfCookieName)?.value;
  if (!csrf) {
    redirect("/api/auth/csrf?next=/settings/security");
  }

  return (
    <SettingsShell title="Security">
      <section>
        <h2>Sessions</h2>
        <p>Absolute session lifetime: {services.policy.absTtlSeconds / 3600}h. Idle timeout: {services.policy.idleTtlSeconds / 60} minutes.</p>
        <form method="post" action="/api/auth/sessions/revoke-all" style={{ marginBottom: "1rem" }}>
          <input type="hidden" name="csrf" value={csrf} />
          <button type="submit">Revoke all sessions</button>
        </form>
        <form method="post" action="/api/auth/logout">
          <input type="hidden" name="csrf" value={csrf} />
          <button type="submit">Log out</button>
        </form>
      </section>
    </SettingsShell>
  );
}
