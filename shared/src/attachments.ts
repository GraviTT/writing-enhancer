export const ATTACHMENT_KINDS = ["file", "image", "screenshot"] as const;

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const ALLOWED_FILE_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type AllowedFileMimeType = (typeof ALLOWED_FILE_MIME_TYPES)[number];
export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export const MAX_ATTACHMENT_COUNT = 5;
export const MAX_IMAGE_ATTACHMENT_COUNT = 4;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_EXTRACTED_TEXT_CHARS = 20_000;
export const MAX_TOTAL_EXTRACTED_TEXT_CHARS = 50_000;
export const MAX_ATTACHMENT_NAME_CHARS = 160;
const MAX_ENCODED_IMAGE_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

export interface AttachmentMetadata {
  id: string;
  kind: AttachmentKind;
  name: string;
  mime_type: AllowedFileMimeType | AllowedImageMimeType;
  size_bytes: number;
  sha256: string | null;
}

/**
 * A provider-ready attachment. Raw document bytes are deliberately excluded:
 * files are represented only by bounded extracted text. Images are accepted
 * only as validated base64, never as remote or local URLs.
 */
export interface ReferenceAttachment extends AttachmentMetadata {
  extracted_text: string | null;
  data_base64: string | null;
}

export interface AttachmentValidationIssue {
  index: number | null;
  code:
    | "not_an_array"
    | "too_many_attachments"
    | "too_many_images"
    | "duplicate_id"
    | "total_size_exceeded"
    | "total_extracted_text_exceeded"
    | "invalid_shape"
    | "unknown_field"
    | "invalid_id"
    | "invalid_kind"
    | "invalid_name"
    | "invalid_mime_type"
    | "invalid_size"
    | "file_too_large"
    | "image_too_large"
    | "invalid_sha256"
    | "file_requires_extracted_text"
    | "file_must_not_include_binary"
    | "image_requires_base64"
    | "invalid_base64"
    | "base64_size_mismatch"
    | "magic_bytes_mismatch"
    | "extracted_text_too_large";
  message: string;
}

export class AttachmentPolicyError extends Error {
  readonly issues: AttachmentValidationIssue[];

  constructor(issues: AttachmentValidationIssue[]) {
    super(`Attachment policy violation: ${issues.map((issue) => issue.code).join(", ")}`);
    this.name = "AttachmentPolicyError";
    this.issues = issues;
  }
}

const FILE_MIME_TYPES = new Set<string>(ALLOWED_FILE_MIME_TYPES);
const IMAGE_MIME_TYPES = new Set<string>(ALLOWED_IMAGE_MIME_TYPES);
const ATTACHMENT_FIELDS = new Set([
  "id",
  "kind",
  "name",
  "mime_type",
  "size_bytes",
  "sha256",
  "extracted_text",
  "data_base64",
]);
const METADATA_FIELDS = new Set([
  "id",
  "kind",
  "name",
  "mime_type",
  "size_bytes",
  "sha256",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedKind(value: unknown): value is AttachmentKind {
  return (
    typeof value === "string" &&
    ATTACHMENT_KINDS.includes(value as AttachmentKind)
  );
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)
  );
}

function isValidName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_ATTACHMENT_NAME_CHARS &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\]/u.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function isValidSha256(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value));
}

function isAllowedFileMime(value: unknown): value is AllowedFileMimeType {
  return typeof value === "string" && FILE_MIME_TYPES.has(value);
}

function isAllowedImageMime(value: unknown): value is AllowedImageMimeType {
  return typeof value === "string" && IMAGE_MIME_TYPES.has(value);
}

interface Base64Inspection {
  decodedSize: number;
  prefix: number[];
}

function base64Sextet(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

/**
 * Iterative validation avoids the catastrophic stack growth caused by a
 * repeated-group RegExp on multi-megabyte base64 strings.
 */
function inspectBase64(value: string): Base64Inspection | null {
  const length = value.length;
  if (length === 0 || length % 4 !== 0) return null;

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataLength = length - padding;
  if (
    (padding === 0 && dataLength % 4 !== 0) ||
    (padding === 1 && dataLength % 4 !== 3) ||
    (padding === 2 && dataLength % 4 !== 2)
  ) {
    return null;
  }

  const prefix: number[] = [];
  let buffer = 0;
  let bits = 0;
  let finalSextet = 0;
  for (let index = 0; index < dataLength; index += 1) {
    const sextet = base64Sextet(value.charCodeAt(index));
    if (sextet < 0) return null;
    finalSextet = sextet;
    buffer = (buffer << 6) | sextet;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      if (prefix.length < 12) prefix.push((buffer >> bits) & 0xff);
    }
    buffer &= bits === 0 ? 0 : (1 << bits) - 1;
  }

  // Canonical base64 requires unused low bits before padding to be zero.
  if ((padding === 2 && (finalSextet & 0x0f) !== 0) ||
      (padding === 1 && (finalSextet & 0x03) !== 0)) {
    return null;
  }

  return {
    decodedSize: (length / 4) * 3 - padding,
    prefix,
  };
}

function hasExpectedImageMagic(
  mimeType: AllowedImageMimeType,
  prefix: readonly number[],
): boolean {
  if (mimeType === "image/png") {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => prefix[index] === byte,
    );
  }
  if (mimeType === "image/jpeg") {
    return prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  }
  return (
    prefix[0] === 0x52 &&
    prefix[1] === 0x49 &&
    prefix[2] === 0x46 &&
    prefix[3] === 0x46 &&
    prefix[8] === 0x57 &&
    prefix[9] === 0x45 &&
    prefix[10] === 0x42 &&
    prefix[11] === 0x50
  );
}

/**
 * Removes control and bidi-control characters before extracted content is
 * placed inside a prompt. This does not make the text trusted: provider
 * requests still label it as untrusted reference data.
 */
export function sanitizeExtractedText(value: string): string {
  return value
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .trim();
}

function inspectMetadata(
  value: Record<string, unknown>,
  index: number,
  allowedFields: ReadonlySet<string>,
): AttachmentValidationIssue[] {
  const issues: AttachmentValidationIssue[] = [];
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      issues.push({
        index,
        code: "unknown_field",
        message: `attachment ${index} contains unknown field '${field}'`,
      });
    }
  }
  if (!isValidId(value.id)) {
    issues.push({ index, code: "invalid_id", message: `attachment ${index} has an invalid id` });
  }
  if (!isAllowedKind(value.kind)) {
    issues.push({
      index,
      code: "invalid_kind",
      message: `attachment ${index} has an invalid kind`,
    });
  }
  if (!isValidName(value.name)) {
    issues.push({
      index,
      code: "invalid_name",
      message: `attachment ${index} has an unsafe or invalid name`,
    });
  }
  if (!Number.isInteger(value.size_bytes) || (value.size_bytes as number) <= 0) {
    issues.push({
      index,
      code: "invalid_size",
      message: `attachment ${index} must declare a positive integer size`,
    });
  }
  if (!isValidSha256(value.sha256)) {
    issues.push({
      index,
      code: "invalid_sha256",
      message: `attachment ${index} has an invalid sha256 digest`,
    });
  }

  if (value.kind === "file") {
    if (!isAllowedFileMime(value.mime_type)) {
      issues.push({
        index,
        code: "invalid_mime_type",
        message: `attachment ${index} uses a disallowed file MIME type`,
      });
    }
    if (typeof value.size_bytes === "number" && value.size_bytes > MAX_FILE_BYTES) {
      issues.push({
        index,
        code: "file_too_large",
        message: `attachment ${index} exceeds the per-file size limit`,
      });
    }
  } else if (value.kind === "image" || value.kind === "screenshot") {
    if (!isAllowedImageMime(value.mime_type)) {
      issues.push({
        index,
        code: "invalid_mime_type",
        message: `attachment ${index} uses a disallowed image MIME type`,
      });
    }
    if (typeof value.size_bytes === "number" && value.size_bytes > MAX_IMAGE_BYTES) {
      issues.push({
        index,
        code: "image_too_large",
        message: `attachment ${index} exceeds the per-image size limit`,
      });
    }
  } else if (typeof value.mime_type !== "string") {
    issues.push({
      index,
      code: "invalid_mime_type",
      message: `attachment ${index} has no valid MIME type`,
    });
  }

  return issues;
}

export function attachmentValidationIssues(
  value: unknown,
): AttachmentValidationIssue[] {
  if (!Array.isArray(value)) {
    return [
      {
        index: null,
        code: "not_an_array",
        message: "attachments must be an array",
      },
    ];
  }

  const issues: AttachmentValidationIssue[] = [];
  if (value.length > MAX_ATTACHMENT_COUNT) {
    issues.push({
      index: null,
      code: "too_many_attachments",
      message: `at most ${MAX_ATTACHMENT_COUNT} attachments are allowed`,
    });
  }

  let imageCount = 0;
  let totalBytes = 0;
  let totalExtractedChars = 0;
  const attachmentIds = new Set<string>();

  value.forEach((attachment, index) => {
    if (!isRecord(attachment)) {
      issues.push({
        index,
        code: "invalid_shape",
        message: `attachment ${index} must be an object`,
      });
      return;
    }

    issues.push(...inspectMetadata(attachment, index, ATTACHMENT_FIELDS));
    if (typeof attachment.id === "string") {
      if (attachmentIds.has(attachment.id)) {
        issues.push({
          index,
          code: "duplicate_id",
          message: `attachment ${index} reuses id '${attachment.id}'`,
        });
      }
      attachmentIds.add(attachment.id);
    }
    if (typeof attachment.size_bytes === "number" && Number.isFinite(attachment.size_bytes)) {
      totalBytes += Math.max(0, attachment.size_bytes);
    }

    const extractedText = attachment.extracted_text;
    if (
      extractedText !== null &&
      typeof extractedText !== "string"
    ) {
      issues.push({
        index,
        code: "invalid_shape",
        message: `attachment ${index} extracted_text must be a string or null`,
      });
    } else if (typeof extractedText === "string") {
      totalExtractedChars += extractedText.length;
      if (extractedText.length > MAX_EXTRACTED_TEXT_CHARS) {
        issues.push({
          index,
          code: "extracted_text_too_large",
          message: `attachment ${index} extracted text exceeds its limit`,
        });
      }
    }

    if (attachment.kind === "file") {
      if (
        typeof extractedText !== "string" ||
        sanitizeExtractedText(extractedText).length === 0
      ) {
        issues.push({
          index,
          code: "file_requires_extracted_text",
          message: `file attachment ${index} requires non-empty extracted text`,
        });
      }
      if (attachment.data_base64 !== null) {
        issues.push({
          index,
          code: "file_must_not_include_binary",
          message: `file attachment ${index} must not include raw binary data`,
        });
      }
      return;
    }

    if (attachment.kind === "image" || attachment.kind === "screenshot") {
      imageCount += 1;
      if (typeof attachment.data_base64 !== "string") {
        issues.push({
          index,
          code: "image_requires_base64",
          message: `image attachment ${index} requires base64 data`,
        });
        return;
      }
      if (attachment.data_base64.length > MAX_ENCODED_IMAGE_CHARS) {
        issues.push({
          index,
          code: "image_too_large",
          message: `image attachment ${index} base64 payload exceeds its limit`,
        });
        return;
      }
      const base64 = inspectBase64(attachment.data_base64);
      if (base64 === null) {
        issues.push({
          index,
          code: "invalid_base64",
          message: `image attachment ${index} contains invalid base64`,
        });
      } else if (base64.decodedSize !== attachment.size_bytes) {
        issues.push({
          index,
          code: "base64_size_mismatch",
          message: `image attachment ${index} size does not match its base64 payload`,
        });
      } else if (
        isAllowedImageMime(attachment.mime_type) &&
        !hasExpectedImageMagic(attachment.mime_type, base64.prefix)
      ) {
        issues.push({
          index,
          code: "magic_bytes_mismatch",
          message: `image attachment ${index} payload does not match its MIME type`,
        });
      }
    }
  });

  if (imageCount > MAX_IMAGE_ATTACHMENT_COUNT) {
    issues.push({
      index: null,
      code: "too_many_images",
      message: `at most ${MAX_IMAGE_ATTACHMENT_COUNT} image attachments are allowed`,
    });
  }
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    issues.push({
      index: null,
      code: "total_size_exceeded",
      message: "combined attachment size exceeds the request limit",
    });
  }
  if (totalExtractedChars > MAX_TOTAL_EXTRACTED_TEXT_CHARS) {
    issues.push({
      index: null,
      code: "total_extracted_text_exceeded",
      message: "combined extracted text exceeds the request limit",
    });
  }
  return issues;
}

export function validateAttachmentBatch(
  value: unknown,
): value is ReferenceAttachment[] {
  return attachmentValidationIssues(value).length === 0;
}

export function prepareAttachments(
  value: readonly ReferenceAttachment[] | undefined,
): ReferenceAttachment[] {
  const attachments = value ?? [];
  const issues = attachmentValidationIssues(attachments);
  if (issues.length > 0) throw new AttachmentPolicyError(issues);
  return attachments.map((attachment) => ({
    ...attachment,
    extracted_text:
      attachment.extracted_text === null
        ? null
        : sanitizeExtractedText(attachment.extracted_text),
  }));
}

export function toAttachmentMetadata(
  attachment: ReferenceAttachment,
): AttachmentMetadata {
  const {
    id,
    kind,
    name,
    mime_type,
    size_bytes,
    sha256,
  } = attachment;
  return { id, kind, name, mime_type, size_bytes, sha256 };
}

export function validateAttachmentMetadata(
  value: unknown,
): value is AttachmentMetadata {
  if (!isRecord(value)) return false;
  return inspectMetadata(value, 0, METADATA_FIELDS).length === 0;
}
