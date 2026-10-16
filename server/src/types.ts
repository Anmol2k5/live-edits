import { z } from "zod/v4";

export const EmailSchema = z.string().trim().min(3).max(254).regex(/^\S+@\S+\.\S+$/);
export const PasswordSchema = z.string().min(10).max(200);
export const DisplayNameSchema = z.string().trim().max(80);
export const WorkspaceNameSchema = z.string().trim().min(1).max(80);
export const RoleSchema = z.enum(["owner", "admin", "member"]);
export type Role = z.infer<typeof RoleSchema>;

export const RegisterSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  displayName: DisplayNameSchema.optional().default(""),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const RecoverRequestSchema = z.object({ email: EmailSchema });
export const RecoverConfirmSchema = z.object({
  token: z.string().min(16).max(256),
  newPassword: PasswordSchema,
});

export const AccountPatchSchema = z.object({
  displayName: DisplayNameSchema.optional(),
  currentPassword: z.string().min(1).max(200).optional(),
  newPassword: PasswordSchema.optional(),
});

export const MomentSchema = z.enum(["wow", "funny", "sad"]);
export type Moment = z.infer<typeof MomentSchema>;

const FileBase = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const MediaNameSchema = FileBase;

export const TriggerPublishSchema = z.object({
  moment: MomentSchema,
  templateId: z.string().min(1).max(64).optional(),
  effectId: z.string().min(1).max(128).optional(),
  mediaFile: MediaNameSchema.optional(),
  durationMs: z.number().int().min(250).max(30000).optional(),
  volume: z.number().min(0).max(1).optional(),
  clipStartMs: z.number().int().min(0).max(600000).optional(),
  clipEndMs: z.number().int().min(1).max(600000).optional(),
  position: z.enum(["center", "fullscreen", "top-left", "top-right", "bottom-left", "bottom-right"]).optional(),
  queue: z.enum(["queue", "interrupt", "replace", "ignore", "coexist"]).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  cooldownMs: z.number().int().min(0).max(60000).optional(),
  triggerId: z.string().min(1).max(128).optional(),
  dedupKey: z.string().min(1).max(128).optional(),
  expiresAt: z.number().int().positive().optional(),
  sequenceNumber: z.number().int().min(0).optional(),
});
export type TriggerPublish = z.infer<typeof TriggerPublishSchema>;

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface PublicWorkspace {
  id: string;
  name: string;
  role: Role;
  activePackUid: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicPack {
  packUid: string;
  name: string;
  version: number;
  data: unknown;
  updatedAt: string;
}

export interface PublicMedia {
  name: string;
  bytes: number;
  kind: "video" | "audio" | "image";
  mime: string;
  version: number;
  createdAt: string;
}

export interface PublicOverlay {
  id: string;
  name: string;
  revoked: boolean;
  createdAt: string;
  rotatedAt: string | null;
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;
export const SIGNED_URL_TTL_MS = 15 * 60 * 1000;
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
export const WORKSPACE_QUOTA_BYTES = 500 * 1024 * 1024;
