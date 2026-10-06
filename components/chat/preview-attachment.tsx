import { FileTextIcon } from "lucide-react";
import Image from "next/image";
import type { Attachment } from "@/lib/types";
import { Spinner } from "../ui/spinner";
import { CrossSmallIcon } from "./icons";

/** "PDF", "DOCX", "TXT"... from a file name. */
function extensionLabel(name: string | undefined) {
  const extension = name?.split(".").pop();
  if (!extension || extension === name || extension.length > 5) {
    return "FILE";
  }
  return extension.toUpperCase();
}

export const PreviewAttachment = ({
  attachment,
  isUploading = false,
  onRemove,
}: {
  attachment: Attachment;
  isUploading?: boolean;
  onRemove?: () => void;
}) => {
  const { name, url, contentType } = attachment;
  const isImage = contentType?.startsWith("image");
  const label = extensionLabel(name);

  return (
    <div
      className="group relative h-24 w-24 shrink-0 overflow-hidden rounded-xl border border-border/40 bg-muted"
      data-testid="input-attachment-preview"
      title={isImage ? undefined : name}
    >
      {isImage ? (
        <Image
          alt={name ?? "attachment"}
          className="size-full object-cover"
          height={96}
          src={url}
          width={96}
        />
      ) : (
        <div className="flex size-full flex-col justify-between p-2">
          <div className="flex items-center gap-1.5">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <FileTextIcon className="size-4" />
            </span>
            <span
              className={
                label === "PDF"
                  ? "rounded bg-red-500/12 px-1 py-px font-semibold text-[9px] text-red-600 tracking-wide dark:text-red-400"
                  : "rounded bg-sky-500/12 px-1 py-px font-semibold text-[9px] text-sky-700 tracking-wide dark:text-sky-400"
              }
            >
              {label}
            </span>
          </div>
          <span className="line-clamp-2 break-all text-[11px] text-foreground/80 leading-tight">
            {name}
          </span>
        </div>
      )}

      {isUploading ? (
        <div
          className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/40 backdrop-blur-sm"
          data-testid="input-attachment-loader"
        >
          <Spinner className="size-5" />
        </div>
      ) : null}

      {onRemove && !isUploading && (
        <button
          aria-label={`Remove ${name ?? "attachment"}`}
          className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-black/80 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          onClick={onRemove}
          type="button"
        >
          <CrossSmallIcon size={10} />
        </button>
      )}
    </div>
  );
};
