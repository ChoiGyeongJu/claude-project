import { z } from 'zod'

export const dartListItemSchema = z.object({
  corp_cls: z.string(),
  corp_name: z.string(),
  corp_code: z.string(),
  stock_code: z.string(),
  report_nm: z.string(),
  rcept_no: z.string(),
  flr_nm: z.string(),
  rcept_dt: z.string(),
  rm: z.string(),
})

export const dartListResponseSchema = z.object({
  status: z.string(),
  message: z.string(),
  list: z.array(dartListItemSchema).optional(),
})

export type DartListItem = z.infer<typeof dartListItemSchema>
export type DartListResponse = z.infer<typeof dartListResponseSchema>

export function parseDartResponse(json: unknown): DartListResponse {
  return dartListResponseSchema.parse(json)
}
