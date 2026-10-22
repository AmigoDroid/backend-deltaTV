import { z } from "zod";

export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

export const pageOf = ({ page, pageSize }) => ({ limit: pageSize, offset: (page - 1) * pageSize });

export const paged = (rows, total, { page, pageSize }) => ({
  data: rows,
  meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
});
