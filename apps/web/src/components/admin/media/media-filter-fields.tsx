import { Input, Label, Select } from "@ecom/ui";
import { getMessages } from "@/messages";
import { flattenFolders, type LibraryFolder } from "./media-types";

const m = getMessages().admin.media;

// Local, nu din @ecom/core: componenta ajunge și în bundle-ul de browser (selectorul), iar core e doar pentru server.
const STATUSES = ["pending", "processing", "ready", "failed"] as const;

/**
 * Câmpurile de căutare și filtrare ale bibliotecii: aceleași în pagina bibliotecii (formular GET,
 * necontrolate, cu `name`) și în selector (controlate, prin `onChange`). Fără hook-uri, deci se
 * pot folosi și într-un server component.
 */
export function MediaFilterFields({
  idPrefix,
  folders,
  q,
  folder,
  status,
  showStatus = true,
  onQChange,
  onFolderChange,
}: {
  idPrefix: string;
  folders: readonly LibraryFolder[];
  q: string;
  folder: string;
  status?: string;
  showStatus?: boolean;
  onQChange?: (value: string) => void;
  onFolderChange?: (value: string) => void;
}) {
  return (
    <>
      <div className="flex min-w-48 flex-1 flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-q`}>{m.search.label}</Label>
        <Input
          id={`${idPrefix}-q`}
          name="q"
          type="search"
          placeholder={m.search.placeholder}
          maxLength={100}
          {...(onQChange
            ? { value: q, onChange: (e) => onQChange(e.target.value) }
            : { defaultValue: q })}
        />
      </div>
      <div className="flex min-w-40 flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-folder`}>{m.filters.folder}</Label>
        <Select
          id={`${idPrefix}-folder`}
          name="folder"
          {...(onFolderChange
            ? { value: folder, onChange: (e) => onFolderChange(e.target.value) }
            : { defaultValue: folder })}
        >
          <option value="">{m.filters.allFolders}</option>
          <option value="root">{m.filters.noFolder}</option>
          {flattenFolders(folders).map(({ folder: f, depth }) => (
            <option key={f.id} value={f.id}>
              {`${"  ".repeat(depth)}${f.name}`}
            </option>
          ))}
        </Select>
      </div>
      {showStatus && (
        <div className="flex min-w-36 flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-status`}>{m.filters.status}</Label>
          <Select id={`${idPrefix}-status`} name="status" defaultValue={status ?? ""}>
            <option value="">{m.filters.allStatuses}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {m.status[s]}
              </option>
            ))}
          </Select>
        </div>
      )}
    </>
  );
}
