"use client";

import { useMemo, useRef, useState } from "react";
import { UploadQueue, xhrSend, type UploadItem } from "@/lib/media-uploader";

/**
 * Coada de încărcări a bibliotecii media, ca hook: aceeași pentru pagina bibliotecii și pentru
 * selector. Max. 2 încărcări simultane, progres, reîncercare la `MEDIA_BUSY`; vezi `UploadQueue`.
 */
export function useMediaUploads(options: {
  /** Folderul în care se încarcă (`null` = fără folder). Citit la fiecare adăugare. */
  folderId: string | null;
  onUploaded?: (item: UploadItem) => void;
}) {
  const [uploads, setUploads] = useState<readonly UploadItem[]>([]);
  const folderRef = useRef(options.folderId);
  folderRef.current = options.folderId;
  const uploadedRef = useRef(options.onUploaded);
  uploadedRef.current = options.onUploaded;

  const queue = useMemo(
    () =>
      new UploadQueue({
        concurrency: 2,
        send: xhrSend,
        onChange: (all) => setUploads([...all]),
        onUploaded: (item) => uploadedRef.current?.(item),
      }),
    [],
  );

  return {
    uploads,
    add: (files: File[]) => queue.add(files, { folderId: folderRef.current, alt: "" }),
    retry: (id: string) => queue.retry(id),
    remove: (id: string) => queue.remove(id),
    clearFinished: () => queue.clearFinished(),
  };
}
