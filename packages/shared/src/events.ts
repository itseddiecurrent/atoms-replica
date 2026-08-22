import { z } from "zod";

const eventBase = {
  eventId: z.number().int().positive(),
  runId: z.uuid(),
  timestamp: z.iso.datetime()
};

export const runEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("run.queued"), payload: z.object({}) }),
  z.object({ ...eventBase, type: z.literal("run.planning"), payload: z.object({}) }),
  z.object({ ...eventBase, type: z.literal("run.coding"), payload: z.object({}) }),
  z.object({ ...eventBase, type: z.literal("run.validating"), payload: z.object({}) }),
  z.object({
    ...eventBase,
    type: z.literal("run.cancelled"),
    payload: z.object({ message: z.string() })
  }),
  z.object({
    ...eventBase,
    type: z.literal("plan.created"),
    payload: z.object({ summary: z.string(), steps: z.array(z.string()) })
  }),
  z.object({
    ...eventBase,
    type: z.literal("step.started"),
    payload: z.object({ step: z.string(), title: z.string() })
  }),
  z.object({
    ...eventBase,
    type: z.literal("assistant.delta"),
    payload: z.object({ text: z.string() })
  }),
  z.object({
    ...eventBase,
    type: z.literal("tool.started"),
    payload: z.object({ tool: z.string(), input: z.record(z.string(), z.unknown()).optional() })
  }),
  z.object({
    ...eventBase,
    type: z.literal("tool.completed"),
    payload: z.object({ tool: z.string(), success: z.boolean(), output: z.string().optional() })
  }),
  z.object({
    ...eventBase,
    type: z.literal("file.created"),
    payload: z.object({ path: z.string() })
  }),
  z.object({
    ...eventBase,
    type: z.literal("file.updated"),
    payload: z.object({ path: z.string() })
  }),
  z.object({
    ...eventBase,
    type: z.literal("file.deleted"),
    payload: z.object({ path: z.string() })
  }),
  z.object({
    ...eventBase,
    type: z.literal("command.output"),
    payload: z.object({ command: z.string(), output: z.string() })
  }),
  z.object({
    ...eventBase,
    type: z.literal("preview.ready"),
    payload: z.object({ url: z.url() })
  }),
  z.object({
    ...eventBase,
    type: z.literal("validation.failed"),
    payload: z.object({ message: z.string(), attempt: z.number().int().nonnegative() })
  }),
  z.object({
    ...eventBase,
    type: z.literal("run.completed"),
    payload: z.object({ summary: z.string() })
  }),
  z.object({
    ...eventBase,
    type: z.literal("run.failed"),
    payload: z.object({ code: z.string(), message: z.string() })
  })
]);

export type RunEvent = z.infer<typeof runEventSchema>;
