import { z } from "zod";

// Corpo de configuração de dispositivo (parceria ou lista própria). Compartilhado pelo painel admin e pelo painel do revendedor.
export const configurationSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("partner"),
    confirm: z.boolean().default(false),
    code: z.string().trim().min(4).max(12).optional(),
    username: z.string().trim().min(1).max(128).optional(),
    password: z.string().min(1).max(128).optional(),
  }),
  z.object({
    mode: z.literal("playlist"),
    confirm: z.boolean().default(false),
    licenseCode: z.string().trim().min(8).max(64).optional(),
    name: z.string().trim().min(1).max(160).optional(),
    url: z.string().trim().min(1).max(2048).optional(),
  }),
]).superRefine((value, ctx) => {
  if (!value.confirm) return;
  const required = value.mode === "partner"
    ? ["code", "username", "password"]
    : ["name", "url"];
  for (const field of required) {
    if (!value[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} é obrigatório para confirmar.` });
  }
});
