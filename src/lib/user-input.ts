/** Shared bounds for administrator-created local accounts. No credentials in errors. */
export function validateNewUser(input: { name: string; email: string; password: string; role: string }) {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name || name.length > 120) return { error: "name" } as const;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "email" } as const;
  if (input.password.length < 12 || input.password.length > 128) return { error: "password" } as const;
  if (input.role !== "member" && input.role !== "admin") return { error: "role" } as const;
  return { value: { name, email, password: input.password, role: input.role } } as const;
}
