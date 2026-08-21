export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload?.message === "string" ? payload.message : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export type CatalogCharacter = { id: string; name: string; description: string | null };
export type CatalogEnvironment = { id: string; name: string; category: string; promptFragment: string };
