import { Wrench } from "lucide-react";
import type { ToolCatalogNotice as ToolCatalogNoticeModel } from "@/app/lib/toolCatalogNotices";

export function ToolCatalogNotice({
  notice,
}: {
  notice: ToolCatalogNoticeModel;
}) {
  const added = notice.addedToolNames.length;
  const removed = notice.removedToolNames.length;
  const addedLabel =
    added === 1 ? notice.addedToolNames[0] : `${added} tools`;
  const removedLabel =
    removed > 0
      ? removed === 1
        ? `, removed ${notice.removedToolNames[0]}`
        : `, removed ${removed} tools`
      : "";
  const grantLabel =
    notice.addedHostedTools.length > 0
      ? " Agent Settings had already granted the hosted tool."
      : "";

  return (
    <div className="my-3 flex justify-center">
      <div className="inline-flex max-w-full items-center gap-2 border border-border bg-paper px-3 py-2 text-xs text-ink-soft shadow-sm">
        <Wrench className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
        <span className="min-w-0 truncate">
          Tool catalog updated: added {addedLabel}
          {removedLabel}.{grantLabel}
        </span>
      </div>
    </div>
  );
}
