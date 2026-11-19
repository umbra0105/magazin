"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Counter, Drawer, DrawerSection } from "@ecom/ui";
import { markNotificationsReadAction } from "@/app/(admin)/admin/notificari-actions";
import { getMessages } from "@/messages";

const t = getMessages().admin.notifications;

export interface BellItem {
  id: string;
  title: string;
  href: string;
  whenText: string;
  read: boolean;
}

/**
 * Clopoțelul din bara de sus (docs/17 §9.8): apare cu datele lui reale (notificările persistente ale utilizatorului, după
 * permisiuni), cu contor de necitite. Click pe o notificare o marchează citită și deschide ecranul ei; «Marchează toate citite»
 * le citește doar pe ale utilizatorului curent.
 */
export function NotificationsBell({ items, unread }: { items: BellItem[]; unread: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  const markAll = () =>
    start(async () => {
      await markNotificationsReadAction({});
      router.refresh();
    });

  const openItem = (item: BellItem) => {
    setOpen(false);
    if (!item.read) {
      start(async () => {
        await markNotificationsReadAction({ ids: [item.id] });
      });
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={unread > 0 ? t.openUnread(unread) : t.open}
        data-notifications-bell
        className="relative flex size-(--control-h) shrink-0 items-center justify-center rounded-md transition-colors duration-(--motion) hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <Bell aria-hidden="true" className="size-5" />
        {unread > 0 && (
          <Counter className="absolute -right-0.5 -top-0.5 px-1" data-bell-count aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </Counter>
        )}
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={t.title}
        closeLabel={t.close}
        actions={
          unread > 0 ? (
            <Button type="button" variant="outline" size="sm" onClick={markAll} disabled={pending}>
              {t.markAll}
            </Button>
          ) : undefined
        }
      >
        {items.length === 0 ? (
          <DrawerSection>
            <p className="text-ink-secondary">{t.empty}</p>
          </DrawerSection>
        ) : (
          <ul className="divide-y divide-line-subtle" data-notifications-list>
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  onClick={() => openItem(item)}
                  className="flex min-h-11 flex-col gap-0.5 px-4 py-3 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  <span className={item.read ? "text-ink" : "font-semibold text-ink"}>
                    {!item.read && <span className="sr-only">{t.unread}: </span>}
                    {item.title}
                  </span>
                  <span className="text-label text-ink-secondary">{item.whenText}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Drawer>
    </>
  );
}
