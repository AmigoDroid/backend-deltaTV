import { z } from "zod";

// Identificadores lógicos de componentes: o cliente nunca executa seletores CSS fornecidos pelo banco.
export const HELP_SCREENS = ["home", "help", "profile", "servers", "codes", "devices", "licenses", "billing", "studio", "apps", "notifications"];
export const HELP_TARGETS = [...HELP_SCREENS, "add-server", "new-code", "search-device"];
export const helpStepSchema = z.object({
  title: z.string().trim().min(2).max(120),
  body: z.string().trim().min(5).max(900),
  target: z.enum(HELP_TARGETS).optional(),
  screen: z.enum(HELP_SCREENS).optional(),
}).strict();
const optionalLink = z.union([z.string().url().max(800).refine(v => v.startsWith("https://"), "Use HTTPS."), z.literal("")]).nullable().optional();
export const helpArticleFields = z.object({
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  title: z.string().trim().min(3).max(160),
  summary: z.string().trim().min(5).max(360),
  category: z.string().trim().min(2).max(60),
  audience: z.enum(["both", "content", "reseller"]),
  body: z.string().trim().min(10).max(10000),
  imageUrl: optionalLink,
  videoUrl: optionalLink,
  steps: z.array(helpStepSchema).max(16),
  sortOrder: z.number().int().min(-500).max(500),
  status: z.enum(["draft", "published", "disabled"]),
  isOnboarding: z.boolean(),
}).strict();
export const helpArticleUpdate = helpArticleFields.partial().refine(v => Object.keys(v).length > 0, "Informe alguma alteração.");
export const helpProgressInput = z.object({ stepIndex: z.number().int().min(0).max(16), completed: z.boolean().optional() }).strict();
