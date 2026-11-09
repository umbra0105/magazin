"use client";

import { Loader2, PackageOpen } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Counter,
  Dialog,
  Drawer,
  DrawerSection,
  EmptyState,
  FileInput,
  Input,
  Label,
  Progress,
  SegmentedBar,
  Select,
  Skeleton,
  Table,
  TableCaption,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tabs,
  ToastProvider,
  Tr,
  useToast,
} from "@ecom/ui";

/**
 * Galeria de componente (docs/17 §7), doar pentru dezvoltare: fiecare componentă în stările ei, cu text românesc real.
 * Starea de cursor deasupra, focus și apăsat se vede interacționând (Tab, mouse); aici se arată cele care se pot fixa:
 * implicită, activă/selectată, dezactivată, încărcare, eroare, goală.
 */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section data-gallery={id} className="flex flex-col gap-3">
      <h2 className="text-section">{title}</h2>
      {children}
    </section>
  );
}

function ToastButtons() {
  const toast = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        onClick={() => toast.notify({ tone: "success", title: "Produsul a fost salvat" })}
      >
        Notificare reușită
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          toast.notify({
            tone: "info",
            title: "Sincronizare în curs",
            description: "Stocul din SmartBill se actualizează.",
          })
        }
      >
        Notificare informativă
      </Button>
      <Button
        variant="outline"
        onClick={() => toast.notify({ tone: "warning", title: "Stoc sub prag la 3 produse" })}
      >
        Notificare de atenție
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          toast.notify({
            tone: "danger",
            title: "Nu am putut salva",
            description: "Verifică conexiunea și încearcă din nou.",
          })
        }
      >
        Eroare (rămâne până o închizi)
      </Button>
    </div>
  );
}

export function Gallery() {
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [selected, setSelected] = useState("p2");

  return (
    <ToastProvider closeLabel="Închide notificarea">
      <div className="mx-auto flex max-w-(--content-max) flex-col gap-10">
        <div className="flex flex-col gap-1">
          <h1 className="text-title">Galerie de componente</h1>
          <p className="text-body text-ink-secondary">
            Doar pentru dezvoltare. Toate componentele din @ecom/ui, în stările lor, cu text
            românesc real.
          </p>
        </div>

        <Section id="font" title="Font (proba diacriticelor)">
          <p data-font-probe className="text-title">
            ă â î ș ț Ă Â Î Ș Ț
          </p>
          <p className="text-body">
            Șurub inox, țeavă PVC, pompă de căldură, Adresă de livrare, Preț cu TVA, Îmbinare,
            Ștergere, Țară.
          </p>
          <p className="text-body tabular-nums">Cifre tabulare: 1.234,50 lei · 0.987 · 111 · 888</p>
        </Section>

        <Section id="colors" title="Culori (suprafețe, text, stare)">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["bg-surface-page", "Pagină"],
              ["bg-surface-subtle", "Subtil"],
              ["bg-surface-hover", "Hover"],
              ["bg-action text-action-fg", "Acțiune"],
              ["bg-tone-neutral-bg text-tone-neutral-fg", "Neutru"],
              ["bg-tone-info-bg text-tone-info-fg", "Informație"],
              ["bg-tone-success-bg text-tone-success-fg", "Succes"],
              ["bg-tone-warning-bg text-tone-warning-fg", "Atenție"],
              ["bg-tone-problem-bg text-tone-problem-fg", "Problemă"],
              ["bg-brand text-on-brand", "Brand"],
              ["bg-kpi-cyan text-ink", "Indicator"],
              ["bg-kpi-peach text-ink", "Indicator"],
            ].map(([classes, label]) => (
              <div
                key={`${classes}-${label}`}
                className={`rounded-lg border border-line-subtle p-3 text-body ${classes}`}
              >
                {label}
              </div>
            ))}
          </div>
        </Section>

        <Section id="buttons" title="Butoane">
          <div className="flex flex-wrap items-center gap-2">
            <Button>Salvează</Button>
            <Button variant="outline">Anulează</Button>
            <Button variant="ghost">Mai târziu</Button>
            <Button variant="destructive">Șterge produsul</Button>
            <Button variant="link">Vezi detalii</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm">Compact</Button>
            <Button size="sm" variant="outline">
              Compact secundar
            </Button>
            <Button disabled>Dezactivat</Button>
            <Button variant="outline" disabled>
              Dezactivat secundar
            </Button>
            <Button disabled aria-busy="true">
              <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />
              Se salvează…
            </Button>
          </div>
        </Section>

        <Section id="fields" title="Câmpuri de formular">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="g-name">Denumire produs</Label>
              <Input id="g-name" placeholder="Ex. Pompă de căldură piscină 12 kW" />
              <p className="text-label text-ink-secondary">Apare în listă și în vitrină.</p>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="g-sku">SKU</Label>
              <Input id="g-sku" defaultValue="PC-12KW-INV" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="g-price">Preț (lei, cu TVA)</Label>
              <Input
                id="g-price"
                defaultValue="abc"
                aria-invalid="true"
                aria-describedby="g-price-err"
              />
              <p id="g-price-err" className="text-label text-tone-problem-fg">
                Introdu un preț valid, de exemplu 1.499,00.
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="g-locked">Cod intern (dezactivat)</Label>
              <Input id="g-locked" defaultValue="SYS-0001" disabled />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="g-brand">Brand</Label>
              <Select id="g-brand" defaultValue="b">
                <option value="a">Astral</option>
                <option value="b">Hayward</option>
                <option value="c">Zodiac</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="g-file">Fișier</Label>
              <FileInput id="g-file" />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label htmlFor="g-desc">Descriere scurtă</Label>
              <Textarea id="g-desc" placeholder="Câteva rânduri despre produs" />
            </div>
          </div>
        </Section>

        <Section id="badges" title="Pastile de stare și contor">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral" dot>
              Neachitat
            </Badge>
            <Badge variant="info" dot>
              Executat
            </Badge>
            <Badge variant="success" dot>
              Achitat
            </Badge>
            <Badge variant="warning" dot>
              Stoc mic
            </Badge>
            <Badge variant="danger" dot>
              Epuizat
            </Badge>
            <Badge variant="success">În stoc</Badge>
            <Counter aria-label="12 comenzi noi">12</Counter>
          </div>
        </Section>

        <Section id="cards" title="Carduri (plate, fără umbră)">
          <div className="grid gap-3 sm:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Card obișnuit</CardTitle>
                <CardDescription>Bordură fină, fără umbră și fără degrade.</CardDescription>
              </CardHeader>
              <CardContent>Conținut.</CardContent>
            </Card>
            <div className="rounded-lg bg-kpi-cyan p-4 text-ink">
              <p className="text-label">Produse active</p>
              <p className="text-kpi tabular-nums">1.234</p>
              <p className="text-label">▲ +12 față de luna trecută</p>
            </div>
            <div className="rounded-lg bg-kpi-peach p-4 text-ink">
              <p className="text-label">Stoc sub prag</p>
              <p className="text-kpi tabular-nums">87</p>
              <p className="text-label">▼ −4 față de luna trecută</p>
            </div>
          </div>
        </Section>

        <Section id="tabs" title="Tab-uri">
          <Tabs
            label="Exemplu de tab-uri"
            tabs={[
              {
                id: "t1",
                label: "General",
                panel: <p className="text-body">Conținutul tabului General.</p>,
              },
              {
                id: "t2",
                label: "Stoc",
                panel: <p className="text-body">Conținutul tabului Stoc.</p>,
              },
              {
                id: "t3",
                label: "Prețuri",
                panel: <p className="text-body">Conținutul tabului Prețuri.</p>,
              },
            ]}
          />
        </Section>

        <Section id="table" title="Tabel (48 px, compact 40 px, rând selectat, cifre la dreapta)">
          <Table>
            <TableCaption>Produse de exemplu</TableCaption>
            <THead>
              <tr>
                <Th aria-sort="ascending">Produs</Th>
                <Th>SKU</Th>
                <Th numeric>Preț</Th>
                <Th numeric>Stoc</Th>
                <Th>Stare</Th>
              </tr>
            </THead>
            <TBody>
              {[
                [
                  "p1",
                  "Pompă de căldură inverter 12 kW",
                  "PC-12KW",
                  "14.990,00 lei",
                  "6",
                  "success",
                  "În stoc",
                ],
                [
                  "p2",
                  "Dezumidificator piscină interioară",
                  "DEZ-60L",
                  "3.450,00 lei",
                  "2",
                  "warning",
                  "Stoc limitat",
                ],
                [
                  "p3",
                  "Cartuș filtrare cu diatomit",
                  "CF-DIA-25",
                  "389,90 lei",
                  "0",
                  "danger",
                  "Epuizat",
                ],
              ].map(([id, name, sku, price, stock, tone, state]) => (
                <Tr key={id} selected={selected === id} onClick={() => setSelected(id as string)}>
                  <Td>{name}</Td>
                  <Td>{sku}</Td>
                  <Td numeric>{price}</Td>
                  <Td numeric>{stock}</Td>
                  <Td>
                    <Badge variant={tone as "success" | "warning" | "danger"} dot>
                      {state}
                    </Badge>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <Table compact>
            <TableCaption>Același tabel, compact</TableCaption>
            <THead>
              <tr>
                <Th>Produs</Th>
                <Th numeric>Stoc</Th>
              </tr>
            </THead>
            <TBody>
              <Tr>
                <Td>Pompă de căldură inverter 12 kW</Td>
                <Td numeric>6</Td>
              </Tr>
              <Tr>
                <Td>Cartuș filtrare cu diatomit</Td>
                <Td numeric>0</Td>
              </Tr>
            </TBody>
          </Table>
        </Section>

        <Section id="stockbar" title="Bara de stoc segmentată">
          <SegmentedBar
            label="Stocul produselor"
            segments={[
              { key: "ok", label: "În stoc", value: 1180, tone: "ok" },
              { key: "low", label: "Stoc mic", value: 87, tone: "low" },
              { key: "out", label: "Epuizat", value: 24, tone: "out" },
            ]}
          />
        </Section>

        <Section id="progress" title="Progres, schelet, stare goală">
          <Progress label="Import în curs" value={64} />
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <Card>
            <EmptyState
              icon={<PackageOpen className="size-8" />}
              title="Nu ai încă produse"
              description="Adaugă primul produs sau importă catalogul dintr-un fișier."
              action={<Button>Adaugă produs</Button>}
            />
          </Card>
        </Section>

        <Section id="overlays" title="Dialog, panou lateral, notificări">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setDialog(true)}>
              Deschide dialogul
            </Button>
            <Button variant="outline" onClick={() => setDrawer(true)}>
              Deschide panoul lateral
            </Button>
          </div>
          <ToastButtons />
        </Section>
      </div>

      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Ștergi produsul?"
        description="Produsul dispare din catalog; comenzile existente își păstrează datele."
        closeLabel="Închide dialogul"
        className="max-w-md"
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDialog(false)}>
            Anulează
          </Button>
          <Button onClick={() => setDialog(false)}>Șterge</Button>
        </div>
      </Dialog>

      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        title="Pompă de căldură inverter 12 kW"
        closeLabel="Închide panoul"
        status={
          <Badge variant="success" dot>
            În stoc
          </Badge>
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setDrawer(false)}>
              Închide
            </Button>
            <Button onClick={() => setDrawer(false)}>Deschide produsul</Button>
          </>
        }
      >
        <DrawerSection title="Rezumat">
          <p className="text-body">SKU PC-12KW · 14.990,00 lei cu TVA · 6 bucăți în stoc.</p>
        </DrawerSection>
        <DrawerSection title="Livrare">
          <p className="text-body">Produs voluminos: livrare doar la adresă, nu la easybox.</p>
        </DrawerSection>
        {Array.from({ length: 6 }, (_, index) => (
          <DrawerSection key={index} title={`Secțiune ${index + 3}`}>
            <p className="text-body">
              Conținut lung ca panoul să derulze, iar acțiunile principale să rămână fixate jos.
            </p>
          </DrawerSection>
        ))}
      </Drawer>
    </ToastProvider>
  );
}
