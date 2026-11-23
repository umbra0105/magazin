"use client";

import { useRef, useState } from "react";
import { StoreButton } from "@ecom/ui";

/**
 * Playerul modulelor digitale (Faza 14b). Cere serverului un link de acces cu expirare scurtă (la fiecare deschidere, nu la
 * încărcarea paginii) și îl pune în `<iframe>` (embed semnat, Bunny) sau `<video>` nativ (linkuri semnate `local`/`s3`). Nu păstrează
 * linkul: la închidere dispare. Cheia de stocare nu ajunge aici niciodată: clientul primește doar linkul semnat.
 *
 * `mode="client"` cere linkul prin POST către ruta clientului (drept de acces, jurnal, filigran); `mode="preview"` prin GET către
 * ruta publică a lecției gratuite (fără cont).
 */
export interface DigitalPlayerTexts {
  play: string;
  close: string;
  preparing: string;
  failed: string;
  title: string;
}

interface Props {
  mode: "client" | "preview";
  assetId: string;
  /** Doar `mode="client"`: jetonul dreptului de acces. */
  token?: string;
  texts: DigitalPlayerTexts;
}

type Playing = { kind: "url" | "embed" | "link"; url: string };

export function DigitalPlayer({ mode, assetId, token, texts }: Props) {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "failed">("idle");
  const [message, setMessage] = useState("");
  const [playing, setPlaying] = useState<Playing | null>(null);
  const live = useRef<HTMLParagraphElement>(null);

  async function open(): Promise<void> {
    setState("loading");
    setMessage("");
    try {
      const response =
        mode === "client"
          ? await fetch("/api/cont/digital/acces", {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({ token, asset: assetId }),
            })
          : await fetch(`/api/digital/previzualizare/${encodeURIComponent(assetId)}`, {
              headers: { accept: "application/json" },
            });
      const body = (await response.json()) as {
        ok?: boolean;
        kind?: Playing["kind"];
        url?: string;
        message?: string;
      };
      if (!response.ok || !body.ok || !body.url || !body.kind) {
        setMessage(body.message ?? texts.failed);
        setState("failed");
        return;
      }
      if (body.kind === "link") {
        window.open(body.url, "_blank", "noopener,noreferrer");
        setState("idle");
        return;
      }
      setPlaying({ kind: body.kind, url: body.url });
      setState("playing");
    } catch {
      setMessage(texts.failed);
      setState("failed");
    }
  }

  function close(): void {
    setPlaying(null);
    setState("idle");
  }

  return (
    <div className="flex flex-col gap-3" data-digital-player>
      {state === "playing" && playing ? (
        <div className="flex flex-col gap-2">
          <div className="aspect-video w-full overflow-hidden rounded-card bg-surface-muted">
            {playing.kind === "embed" ? (
              <iframe
                src={playing.url}
                title={texts.title}
                className="h-full w-full border-0"
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                referrerPolicy="no-referrer"
              />
            ) : (
              <video
                src={playing.url}
                controls
                playsInline
                preload="metadata"
                controlsList="nodownload"
                className="h-full w-full"
              >
                <track kind="captions" />
              </video>
            )}
          </div>
          <div>
            <StoreButton type="button" variant="secondary" onClick={close}>
              {texts.close}
            </StoreButton>
          </div>
        </div>
      ) : (
        <div>
          <StoreButton
            type="button"
            variant="primary"
            onClick={open}
            disabled={state === "loading"}
          >
            {state === "loading" ? texts.preparing : texts.play}
          </StoreButton>
        </div>
      )}
      <p
        ref={live}
        role={state === "failed" ? "alert" : undefined}
        aria-live="polite"
        className="text-sm text-tone-problem-fg"
      >
        {state === "failed" ? message : ""}
      </p>
    </div>
  );
}
