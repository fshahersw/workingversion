import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRight,
  BadgeCheck,
  Building2,
  FlaskConical,
  Scale,
  Camera,
  ChevronRight,
  Gavel,
  Landmark,
  Loader2,
  Newspaper,
  Pencil,
  Sparkles,
  X,
} from "lucide-react";

import { EMPTY_PROFILE, fileToDataUrl, readProfile, writeProfile } from "@/lib/local-profile";
import { staticHeadlines, type Headline } from "@/lib/news-static";

import { useAuth } from "@/lib/use-auth";
import logoAsset from "@/assets/sw-logo.asset.json";

// ---------------- Types & constants ----------------

type Category = "all" | "mdl" | "regulatory" | "courts" | "science" | "settlements" | "general";

const CATS: { id: Category; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "all", label: "All", icon: Newspaper },
  { id: "mdl", label: "MDL / Mass Tort", icon: Scale },
  { id: "regulatory", label: "FDA / Recalls", icon: BadgeCheck },
  { id: "courts", label: "Courts", icon: Gavel },
  { id: "science", label: "Science", icon: FlaskConical },
  { id: "settlements", label: "Settlements", icon: Landmark },
];

// Per-category tint tokens for the row pill. Only categories with an entry render a pill.
const CAT_TINT: Record<string, { label: string; bg: string; text: string; dot: string }> = {
  mdl:         { label: "MDL",        bg: "bg-blue-50",    text: "text-blue-700",    dot: "bg-blue-500" },
  regulatory:  { label: "FDA",        bg: "bg-amber-50",   text: "text-amber-700",   dot: "bg-amber-500" },
  courts:      { label: "Courts",     bg: "bg-violet-50",  text: "text-violet-700",  dot: "bg-violet-500" },
  science:     { label: "Science",    bg: "bg-teal-50",    text: "text-teal-700",    dot: "bg-teal-500" },
  settlements: { label: "Settlement", bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500" },
};

// Strip markdown noise (hashtags, leading #, stray markdown) from article title/snippet text
function cleanText(input?: string | null): string {
  if (!input) return "";
  return input
    .replace(/^\s*#+\s*/gm, "")           // leading heading markers
    .replace(/\s#+\s+/g, " ")             // inline "## " runs
    .replace(/#{2,}/g, "")                // bare "##", "###"
    .replace(/[*_`>]+/g, "")              // md emphasis / quotes / code ticks
    .replace(/\s{2,}/g, " ")
    .trim();
}


const QUICK_STARTS = [
  { text: "Summarize the latest CMOs and bellwether schedule in the most active pharmaceutical MDL.", icon: Scale },
  { text: "What recent FDA recalls or warning letters could support new product liability claims?", icon: BadgeCheck },
  { text: "How have courts treated general causation experts under Daubert in talc and Roundup litigation?", icon: FlaskConical },
  { text: "Outline a plaintiff fact sheet and case-intake screen for a defective medical device claim.", icon: Building2 },
];

// Illustrative docket snapshot. Wire to a live docket feed later.
const DOCKET = {
  month: "Active MDL snapshot",
  cols: ["Venue", "Pending", "Next bellwether"],
  rows: [
    { cat: "Talc", row: ["D.N.J.", "58,400", "Mar 2026"] },
    { cat: "Roundup", row: ["N.D. Cal.", "4,200", "Current"] },
    { cat: "Hair relaxer", row: ["N.D. Ill.", "10,900", "Sep 2026"] },
    { cat: "CPAP", row: ["W.D. Pa.", "2,600", "Current"] },
  ],
};

// ---------------- Data hooks ----------------

function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    staleTime: Infinity,
    refetchOnMount: "always",
    queryFn: async () => readProfile(),
    initialData: EMPTY_PROFILE,
  });
}


function useHeadlines(cat: Category) {
  return useQuery<Headline[]>({
    queryKey: ["headlines", cat],
    staleTime: Infinity,
    queryFn: async () => staticHeadlines(cat),
    initialData: () => staticHeadlines(cat),
  });
}



// ---------------- Utilities ----------------

function relTime(iso?: string | null) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function initialsOf(name?: string | null, email?: string | null) {
  const src = (name || email || "").trim();
  if (!src) return "U";
  const parts = src.split(/\s+|@|\./).filter(Boolean);
  return (parts[0]?.[0] ?? "").concat(parts[1]?.[0] ?? "").toUpperCase() || "U";
}

// ---------------- Components ----------------

export function HomeDashboard() {
  const { user } = useAuth();
  const [cat, setCat] = useState<Category>("all");
  const [editing, setEditing] = useState(false);

  const profile = useProfile();
  const avatarUrl = profile.data?.avatar_data_url ?? null;
  const news = useHeadlines(cat);

  const navigate = useNavigate();

  // Time-of-day and locale dates differ between the server render and the
  // browser, so they are resolved after mount (see `mounted` below).
  const [greeting, setGreeting] = useState("Welcome");
  const [todayLabel, setTodayLabel] = useState("");
  useEffect(() => {
    const h = new Date().getHours();
    setGreeting(h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
    setTodayLabel(
      new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }),
    );
  }, []);

  const displayName = profile.data?.full_name?.split(" ")[0] || user?.email?.split("@")[0] || "there";

  function startWithPrompt(text: string) {
    try { sessionStorage.setItem("sw:initial-prompt", text); } catch { /* noop */ }
    navigate({ to: "/research" });
  }

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const latestFetched = news.data?.[0]?.fetched_at;
  const totalCount = mounted ? (news.data?.length ?? 0) : 0;

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="mx-auto flex w-full max-w-[1240px] flex-1 flex-col overflow-hidden px-4 pb-3 pt-1 sm:px-6 lg:px-8">
        {/* Editorial header */}
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28 }}
          className="mb-3 flex shrink-0 items-end justify-between gap-4"
        >
          <div className="min-w-0">
            <p className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-brand-navy/50">
              {todayLabel || "\u00A0"}
            </p>

            <h1 className="mt-1 truncate text-[19px] font-semibold tracking-tight text-brand-navy sm:text-[21px]">
              {greeting}, {displayName}.
            </h1>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              Mass tort and complex litigation signal, curated for your practice.
            </p>
          </div>
          <div className="hidden shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 text-[10.5px] font-medium text-brand-navy/70 sm:inline-flex">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/60" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            {mounted && latestFetched ? `Live · updated ${relTime(latestFetched)}` : "Live feed"}
          </div>
        </motion.div>

        {/* Content grid */}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-12 lg:overflow-hidden">
          {/* News panel */}
          <section className="min-h-0 lg:col-span-8 lg:h-full">
            <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card shadow-[0_1px_2px_rgba(15,26,60,0.04)]">
              {/* Card header with soft wash */}
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-linear-to-b from-brand-blue-soft/50 to-card px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <div className="grid h-6 w-6 place-items-center rounded-md bg-brand-navy/8 text-brand-navy">
                    <Newspaper className="h-3.5 w-3.5" />
                  </div>
                  <h2 className="text-[12.5px] font-semibold tracking-tight text-brand-navy">
                    Litigation signal
                  </h2>
                </div>
                <span className="text-[10.5px] tabular-nums text-brand-navy/50">
                  {totalCount} headline{totalCount === 1 ? "" : "s"}
                </span>
              </div>

              {/* Segmented category control */}
              <div className="shrink-0 border-b border-border/70 px-3 py-2">
                <div className="inline-flex w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-muted/60 p-0.5">
                  {CATS.map((c) => {
                    const active = cat === c.id;
                    return (
                      <button
                        key={c.id}
                        onClick={() => setCat(c.id)}
                        className={[
                          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-all",
                          active
                            ? "bg-card text-brand-navy shadow-[0_1px_2px_rgba(15,26,60,0.08)]"
                            : "text-brand-navy/60 hover:text-brand-navy",
                        ].join(" ")}
                      >
                        <c.icon className="h-3 w-3" />
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Article list */}
              <div className="min-h-0 flex-1 divide-y divide-border/50 overflow-y-auto">
                {news.isLoading && !news.data && (
                  <div className="flex items-center gap-2 px-5 py-8 text-[12.5px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading headlines…
                  </div>
                )}
                {!news.isLoading && (news.data?.length ?? 0) === 0 && (
                  <div className="px-5 py-10 text-center">
                    <p className="text-[13px] font-medium text-brand-navy">No headlines yet</p>
                    <p className="mt-1 text-[11.5px] text-muted-foreground">
                      The feed refreshes hourly — check back shortly.
                    </p>
                  </div>
                )}
                <AnimatePresence initial={false}>
                  {(news.data ?? []).map((h, i) => {
                    const tint = CAT_TINT[h.category];
                    const title = cleanText(h.title);
                    const snippet = cleanText(h.snippet);
                    return (
                      <motion.a
                        key={h.id}
                        href={h.url}
                        target="_blank"
                        rel="noreferrer"
                        initial={{ opacity: 0, y: 3 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2, delay: Math.min(i * 0.012, 0.12) }}
                        className="group relative block px-4 py-3 transition-colors hover:bg-muted/50"
                      >
                        <div className="flex items-start gap-3.5">
                          <NewsThumbnail imageUrl={h.image_url} sourceDomain={h.source_domain} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <p className="line-clamp-2 flex-1 text-[13px] font-medium leading-snug text-foreground">
                                {title}
                              </p>
                              {tint && (
                                <span
                                  className={[
                                    "hidden shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wider sm:inline-flex",
                                    tint.bg,
                                    tint.text,
                                  ].join(" ")}
                                >
                                  <span className={["h-1 w-1 rounded-full", tint.dot].join(" ")} />
                                  {tint.label}
                                </span>
                              )}
                            </div>
                            {snippet && (
                              <p className="mt-1 line-clamp-2 text-[11.5px] leading-[1.55] text-muted-foreground">
                                {snippet}
                              </p>
                            )}
                            <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                              <span className="font-medium text-foreground/70">
                                {h.source_domain || "source"}
                              </span>
                              <span className="text-border">·</span>
                              <span className="tabular-nums">
                                {relTime(h.published_at ?? h.fetched_at)}
                              </span>
                              <ArrowUpRight className="ml-auto h-3 w-3 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground" />
                            </div>
                          </div>
                        </div>
                      </motion.a>
                    );
                  })}
                </AnimatePresence>

              </div>
            </div>
          </section>

          {/* Right column */}
          <aside className="min-h-0 space-y-3 lg:col-span-4 lg:h-full lg:overflow-y-auto lg:pr-0.5">
            {/* Profile card */}
            <div className="rounded-xl border border-border/70 bg-card p-3.5 shadow-[0_1px_2px_rgba(15,26,60,0.04)]">
              <div className="flex items-center gap-3">
                <div className="relative h-10 w-10 shrink-0">
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}

                      alt="Avatar"
                      className="h-10 w-10 rounded-full object-cover ring-1 ring-border/70"
                    />
                  ) : (
                    <div className="grid h-10 w-10 place-items-center rounded-full bg-brand-blue-soft text-[11.5px] font-semibold text-brand-navy ring-1 ring-border/70">
                      {initialsOf(profile.data?.full_name, user?.email)}
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-brand-navy">
                    {profile.data?.full_name || "Add your name"}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {profile.data?.title || user?.email}
                  </p>
                </div>
                <button
                  onClick={() => setEditing(true)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] font-medium text-brand-navy/60 transition-colors hover:bg-brand-blue-soft hover:text-brand-navy"
                  aria-label="Edit profile"
                >
                  <Pencil className="h-3 w-3" />
                  Edit
                </button>
              </div>
            </div>

            {/* Visa bulletin snapshot */}
            <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-[0_1px_2px_rgba(15,26,60,0.04)]">
              <div className="flex items-center gap-2 border-b border-border/70 bg-linear-to-b from-brand-blue-soft/50 to-card px-3.5 py-2.5">
                <div className="grid h-6 w-6 place-items-center rounded-md bg-brand-navy/8 text-brand-navy">
                  <Scale className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-[12.5px] font-semibold tracking-tight text-brand-navy">
                    Docket watch
                  </h3>
                  <p className="text-[10px] text-brand-navy/50">{DOCKET.month}</p>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11.5px]">
                  <thead>
                    <tr className="text-left">
                      <th className="px-3.5 py-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-brand-navy/45">
                        Cat.
                      </th>
                      {DOCKET.cols.map((c) => (
                        <th
                          key={c}
                          className="px-2 py-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-brand-navy/45"
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {DOCKET.rows.map((r, ri) => (
                      <tr
                        key={r.cat}
                        className={ri % 2 === 1 ? "bg-brand-blue-soft/30" : ""}
                      >
                        <td className="px-3.5 py-1.5 font-semibold text-brand-navy">
                          {r.cat}
                        </td>
                        {r.row.map((v, i) => {
                          const isCurrent = v.toLowerCase() === "current";
                          return (
                            <td key={i} className="px-2 py-1.5 tabular-nums text-brand-navy/80">
                              {isCurrent ? (
                                <span className="inline-flex items-center rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                                  Current
                                </span>
                              ) : (
                                v
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="border-t border-border/50 px-3.5 py-1.5 text-[9.5px] text-muted-foreground">
                Illustrative snapshot. Confirm against PACER / JPML statistics.
              </p>
            </div>

            {/* Quick starts */}
            <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-[0_1px_2px_rgba(15,26,60,0.04)]">
              <div className="flex items-center gap-2 border-b border-border/70 bg-linear-to-b from-brand-orange-soft/60 to-card px-3.5 py-2.5">
                <div className="grid h-6 w-6 place-items-center rounded-md bg-brand-orange/10 text-brand-orange">
                  <Sparkles className="h-3.5 w-3.5" />
                </div>
                <h3 className="text-[12.5px] font-semibold tracking-tight text-brand-navy">
                  Quick start
                </h3>
              </div>
              <div className="divide-y divide-border/50">
                {QUICK_STARTS.map((q) => (
                  <button
                    key={q.text}
                    onClick={() => startWithPrompt(q.text)}
                    className="group flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-brand-blue-soft/40"
                  >
                    <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-brand-blue-soft text-brand-navy/70 group-hover:text-brand-navy">
                      <q.icon className="h-3.5 w-3.5" />
                    </div>
                    <span className="line-clamp-2 flex-1 text-[11.5px] leading-snug text-brand-navy">
                      {q.text}
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-brand-navy/25 transition-colors group-hover:text-brand-navy" />
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>

      <AnimatePresence>
        {editing && (
          <ProfileEditDialog
            key="edit"
            onClose={() => setEditing(false)}
            initial={{
              full_name: profile.data?.full_name ?? "",
              title: profile.data?.title ?? "",
              avatarUrl: avatarUrl ?? undefined,
            }}
          />
        )}
      </AnimatePresence>

    </div>
  );
}

// ---------------- News thumbnail with branded fallback ----------------

function NewsThumbnail({ imageUrl, sourceDomain }: { imageUrl?: string | null; sourceDomain?: string | null }) {
  const [failed, setFailed] = useState(false);
  const showImage = !!imageUrl && !failed;
  const favicon = sourceDomain
    ? `https://www.google.com/s2/favicons?domain=${sourceDomain}&sz=128`
    : null;

  return (
    <div className="relative h-[68px] w-[92px] shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-border/70 sm:h-[72px] sm:w-[104px]">
      {showImage ? (
        <img
          src={imageUrl!}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="grid h-full w-full place-items-center">
          {favicon ? (
            <img
              src={favicon}
              alt=""
              loading="lazy"
              className="h-5 w-5 opacity-70"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <Newspaper className="h-4 w-4 text-brand-navy/40" />
          )}
        </div>
      )}
    </div>
  );
}



function ProfileEditDialog({
  onClose,
  initial,
}: {
  onClose: () => void;
  initial: { full_name: string; title: string; avatarUrl?: string };
}) {
  const qc = useQueryClient();
  const [fullName, setFullName] = useState(initial.full_name);
  const [title, setTitle] = useState(initial.title);
  const [preview, setPreview] = useState<string | undefined>(initial.avatarUrl);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setPreview(initial.avatarUrl), [initial.avatarUrl]);

  function onPick(f: File | undefined) {
    if (!f) return;
    if (!/^image\//.test(f.type)) return setErr("Please choose an image file.");
    if (f.size > 2 * 1024 * 1024) return setErr("Image must be under 2 MB.");
    setErr(null);
    setFile(f);
    const url = URL.createObjectURL(f);
    setPreview(url);
  }

  async function onSave() {
    setBusy(true);
    setErr(null);
    try {
      const avatarDataUrl = file ? await fileToDataUrl(file) : (initial.avatarUrl ?? null);
      writeProfile({
        full_name: fullName.trim() || null,
        title: title.trim() || null,
        avatar_data_url: avatarDataUrl && avatarDataUrl.startsWith("data:") ? avatarDataUrl : null,
      });
      await qc.invalidateQueries({ queryKey: ["profile"] });
      onClose();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setBusy(false);
    }
  }


  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.98 }}
        transition={{ duration: 0.18 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[420px] overflow-hidden rounded-2xl border border-border bg-card shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="text-[14px] font-semibold text-brand-navy">Edit profile</h3>
          <button onClick={onClose} className="rounded-full p-1 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="flex items-center gap-4">
            <label className="group relative cursor-pointer">
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => onPick(e.target.files?.[0] ?? undefined)}
              />
              {preview ? (
                <img src={preview} alt="" className="h-16 w-16 rounded-full object-cover ring-1 ring-border" />
              ) : (
                <div className="grid h-16 w-16 place-items-center rounded-full bg-brand-blue-soft ring-1 ring-border">
                  <img src={logoAsset.url} alt="Seeger Weiss LLP" className="h-6 w-auto opacity-70" />
                </div>
              )}
              <div className="absolute inset-0 grid place-items-center rounded-full bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                <Camera className="h-4 w-4 text-white" />
              </div>
            </label>
            <div className="text-[12px] text-muted-foreground">
              Upload a square image, under 2 MB.
              <br />
              Only you can view the original file.
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-brand-navy">Name</label>
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="block w-full rounded-lg border border-border bg-background px-3 py-2 text-[13.5px] focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/15"
              placeholder="Jane Doe"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-brand-navy">Position</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="block w-full rounded-lg border border-border bg-background px-3 py-2 text-[13.5px] focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/15"
              placeholder="Associate Attorney"
            />
          </div>

          {err && <p className="text-[12px] text-red-600">{err}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-[12.5px] font-medium text-brand-navy hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-navy px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-brand-navy/90 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
