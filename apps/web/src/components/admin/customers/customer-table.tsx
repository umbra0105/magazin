"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Dialog, Label, Select, TBody, THead, Table, Td, Th, Tr } from "@ecom/ui";
import { assignCustomerGroup, assignCustomerGroupBulk } from "@/app/(admin)/admin/clienti/actions";
import type { ProductActionFailure } from "@/lib/product-action-support";
import { getMessages } from "@/messages";

const m = getMessages().admin.customers;

export interface CustomerGroupOption {
  id: string;
  name: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  isSystem: boolean;
  isActive: boolean;
}

export interface CustomerTableRow {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  joinedText: string;
  /** `null` = fără grup atribuit (se comportă ca «Client standard»). */
  groupId: string | null;
}

function errorText(result: ProductActionFailure): string {
  return result.message ?? m.errors[result.code] ?? m.errors.generic ?? "";
}

/**
 * Lista clienților cu grupul fiecăruia: mutare individuală (selectorul de pe rând) și în masă (alegi clienții, apoi grupul). Doar cu
 * `customers.write` apar selectoarele; serverul verifică permisiunea la fiecare acțiune. Grupul unui client fără grup atribuit se
 * arată ca grupul de sistem («Client standard»).
 */
export function CustomerTable({
  rows,
  groups,
  canWrite,
}: {
  rows: readonly CustomerTableRow[];
  groups: readonly CustomerGroupOption[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const system = groups.find((group) => group.isSystem);
  const byId = new Map(groups.map((group) => [group.id, group]));
  const assignable = groups.filter((group) => group.isActive);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkTarget, setBulkTarget] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pending, startTransition] = useTransition();

  const groupOf = (groupId: string | null) => (groupId ? byId.get(groupId) : system) ?? system;
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const moveOne = (row: CustomerTableRow, value: string) => {
    const target = value === "" ? null : value;
    startTransition(async () => {
      try {
        const result = await assignCustomerGroup({ userId: row.id, groupId: target });
        if (result.ok) {
          setProblem(null);
          setAnnouncement(
            m.live.moved(row.name, target ? (byId.get(target)?.name ?? "") : m.noGroup),
          );
          router.refresh();
        } else {
          setProblem(errorText(result));
          router.refresh();
        }
      } catch {
        setProblem(m.errors.generic ?? "");
      }
    });
  };

  const moveMany = () => {
    const target = bulkTarget === "" ? null : bulkTarget;
    startTransition(async () => {
      try {
        const result = await assignCustomerGroupBulk({ userIds: [...selected], groupId: target });
        setConfirming(false);
        if (result.ok) {
          setProblem(null);
          setSelected(new Set());
          setAnnouncement(
            m.live.movedMany(result.moved, target ? (byId.get(target)?.name ?? "") : m.noGroup),
          );
          router.refresh();
        } else {
          setProblem(errorText(result));
        }
      } catch {
        setConfirming(false);
        setProblem(m.errors.generic ?? "");
      }
    });
  };

  const targetName = bulkTarget === "" ? m.noGroup : (byId.get(bulkTarget)?.name ?? "");

  return (
    <div className="flex flex-col gap-4">
      {problem && (
        <p
          role="alert"
          data-problem
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {problem}
        </p>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {canWrite && selected.size > 0 && (
        <section
          aria-label={m.bulk.title}
          data-bulk-bar
          className="flex flex-wrap items-end gap-3 rounded-lg bg-surface-subtle p-3"
        >
          <p className="text-body font-medium" data-bulk-count>
            {m.bulk.selected(selected.size)}
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-group">{m.bulk.groupLabel}</Label>
            <Select
              id="bulk-group"
              value={bulkTarget}
              onChange={(event) => setBulkTarget(event.target.value)}
            >
              <option value="">{m.noGroup}</option>
              {assignable.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </Select>
          </div>
          <Button onClick={() => setConfirming(true)} disabled={pending} data-bulk-apply>
            {m.bulk.apply}
          </Button>
          <Button variant="outline" onClick={() => setSelected(new Set())}>
            {m.bulk.clear}
          </Button>
        </section>
      )}

      <Table stacked aria-label={m.listLabel}>
        <THead>
          <Tr>
            {canWrite && (
              <Th>
                <input
                  type="checkbox"
                  className="size-4"
                  aria-label={m.selectAll}
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.id)))
                  }
                />
              </Th>
            )}
            <Th>{m.columns.name}</Th>
            <Th priority="secondary">{m.columns.email}</Th>
            <Th priority="tertiary">{m.columns.verified}</Th>
            <Th priority="tertiary">{m.columns.joined}</Th>
            <Th>{m.columns.group}</Th>
            {canWrite && <Th>{m.columns.move}</Th>}
          </Tr>
        </THead>
        <TBody>
          {rows.map((row) => {
            const group = groupOf(row.groupId);
            return (
              <Tr key={row.id} data-customer-row={row.id}>
                {canWrite && (
                  <Td>
                    <input
                      type="checkbox"
                      className="size-4"
                      aria-label={m.selectRow(row.name)}
                      checked={selected.has(row.id)}
                      onChange={() => toggle(row.id)}
                    />
                  </Td>
                )}
                <Td className="font-medium">{row.name}</Td>
                <Td priority="secondary" className="text-ink-secondary">
                  {row.email}
                </Td>
                <Td priority="tertiary">{row.emailVerified ? m.verified.yes : m.verified.no}</Td>
                <Td priority="tertiary" className="whitespace-nowrap text-ink-secondary">
                  {row.joinedText}
                </Td>
                <Td data-cell="group">
                  {group && (
                    <Badge variant={group.tone} data-group-badge={group.id}>
                      {group.name}
                    </Badge>
                  )}
                </Td>
                {canWrite && (
                  <Td>
                    <Select
                      aria-label={m.groupOf(row.name)}
                      value={row.groupId ?? ""}
                      disabled={pending}
                      data-group-select
                      onChange={(event) => moveOne(row, event.target.value)}
                    >
                      <option value="">{m.noGroup}</option>
                      {groups
                        .filter((candidate) => candidate.isActive || candidate.id === row.groupId)
                        .map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.name}
                          </option>
                        ))}
                    </Select>
                  </Td>
                )}
              </Tr>
            );
          })}
        </TBody>
      </Table>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={m.bulk.confirmTitle}
        closeLabel={m.bulk.close}
        className="max-w-lg"
      >
        <div className="flex flex-col gap-4">
          <p className="text-body">{m.bulk.confirmBody(selected.size, targetName)}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {m.bulk.cancel}
            </Button>
            <Button onClick={moveMany} disabled={pending} data-bulk-confirm>
              {m.bulk.confirm}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
