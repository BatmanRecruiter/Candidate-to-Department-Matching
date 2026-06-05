import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  FileSpreadsheet,
  Download,
  CheckCircle2,
  AlertCircle,
  Layers,
  MapPin,
  Briefcase,
  XCircle,
  Loader2,
  Sparkles,
  Archive,
  RefreshCw,
  Check,
  SlidersHorizontal,
  LockKeyhole,
  Eye,
} from "lucide-react";
import { PhDataMark } from "@/components/logo";
import { parseCsvText, rowsToCsv, downloadCsv } from "@/lib/csv";
import {
  buildExportHeaders,
  buildExportRow,
} from "@/lib/export";
import type { MatchResult, RoleLibraryJob } from "@shared/matcher";
import { APPENDED_COLUMNS, COLUMN_TEMPLATE } from "@shared/template";
import type { CalibrationSummary, SavedFileSummary } from "@shared/schema";

interface LibraryResponse {
  generated_at: string;
  jobs: RoleLibraryJob[];
}

interface ProcessedState {
  inputHeaders: string[];
  inputRows: Record<string, string>[];
  results: MatchResult[];
  exportHeaders: string[];
  exportRows: string[][];
  fileName: string;
}

interface SavedFileResponse extends SavedFileSummary {}
interface CalibrationResponse extends CalibrationSummary {}

interface RoleSyncRunSummary {
  id: string;
  startedAt: number;
  finishedAt: number;
  status: "success" | "error" | "partial";
  source: "manual" | "automated";
  rolesFound: number;
  rolesNew: number;
  rolesUpdated: number;
  rolesDeactivated: number;
  errorMessage: string | null;
}

interface RoleSyncStatusResponse {
  lastRun: RoleSyncRunSummary | null;
  syncedRolesTotal: number;
  syncedRolesActive: number;
  bundledRolesCount: number;
}

interface RoleSyncResultResponse {
  status: "success" | "error" | "partial";
  source: "manual" | "automated";
  startedAt: number;
  finishedAt: number;
  rolesFound: number;
  rolesNew: number;
  rolesUpdated: number;
  rolesDeactivated: number;
  errorMessage?: string;
  newRoles: Array<{ jobId: string; title: string; department: string }>;
  updatedRoles: Array<{ jobId: string; title: string; department: string }>;
}

export default function Home() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<ProcessedState | null>(null);
  const [adminPasscode, setAdminPasscode] = useState("");

  const libraryQ = useQuery<LibraryResponse>({
    queryKey: ["/api/role-library"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/role-library");
      return res.json();
    },
  });

  const jobs = libraryQ.data?.jobs || [];

  const savedFilesQ = useQuery<SavedFileResponse[]>({
    queryKey: ["/api/saved-files", adminPasscode.trim()],
    queryFn: async () => {
      if (!adminPasscode.trim()) return [];
      const res = await apiRequest("GET", "/api/saved-files", undefined, {
        "x-admin-passcode": adminPasscode.trim(),
      });
      return res.json();
    },
    enabled: !!adminPasscode.trim(),
  });

  const calibrationsQ = useQuery<CalibrationResponse[]>({
    queryKey: ["/api/calibrations", adminPasscode.trim()],
    queryFn: async () => loadCalibrations(adminPasscode.trim()),
    enabled: !!adminPasscode.trim(),
  });

  const roleSyncStatusQ = useQuery<RoleSyncStatusResponse>({
    queryKey: ["/api/role-sync/status", adminPasscode.trim()],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/role-sync/status", undefined, {
        "x-admin-passcode": adminPasscode.trim(),
      });
      return res.json();
    },
    enabled: !!adminPasscode.trim(),
  });

  const [syncing, setSyncing] = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState<RoleSyncResultResponse | null>(null);

  const onRunRoleSync = useCallback(async () => {
    const passcode = adminPasscode.trim();
    if (!passcode) {
      toast({
        title: "Admin passcode required",
        description: "Enter the admin passcode to sync live phData roles.",
        variant: "destructive",
      });
      return;
    }
    setSyncing(true);
    try {
      const res = await apiRequest("POST", "/api/role-sync", undefined, {
        "x-admin-passcode": passcode,
      });
      const result = (await res.json()) as RoleSyncResultResponse;
      setLastSyncResult(result);
      queryClient.invalidateQueries({ queryKey: ["/api/role-sync/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/role-library"] });
      if (result.status === "error") {
        toast({
          title: "Role sync failed",
          description: result.errorMessage || "Unknown error syncing roles.",
          variant: "destructive",
        });
      } else {
        toast({
          title: result.status === "partial" ? "Role sync partial" : "Role sync complete",
          description: `${result.rolesFound} found · ${result.rolesNew} new · ${result.rolesUpdated} updated · ${result.rolesDeactivated} deactivated`,
        });
      }
    } catch (err) {
      toast({
        title: "Role sync failed",
        description: err instanceof Error ? err.message : "Check the admin passcode and try again.",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  }, [adminPasscode, toast]);

  const latestCalibrationByKey = useMemo(
    () => latestCalibrationMap(calibrationsQ.data || []),
    [calibrationsQ.data],
  );

  const correctionCount = useMemo(
    () => (calibrationsQ.data || []).filter((c) => c.isCorrect === 0).length,
    [calibrationsQ.data],
  );

  const [analysisText, setAnalysisText] = useState<string | null>(null);
  const [analysisRunning, setAnalysisRunning] = useState(false);

  const onRunAnalysis = useCallback(async () => {
    const passcode = adminPasscode.trim();
    if (!passcode) return;
    setAnalysisRunning(true);
    setAnalysisText(null);
    try {
      const res = await apiRequest(
        "GET",
        "/api/calibrations/analysis?generate=true",
        undefined,
        { "x-admin-passcode": passcode },
      );
      const data = await res.json() as { correctionCount: number; analysis: string | null };
      setAnalysisText(data.analysis ?? "No analysis returned.");
    } catch {
      toast({ title: "Analysis failed", description: "Could not generate calibration analysis.", variant: "destructive" });
    } finally {
      setAnalysisRunning(false);
    }
  }, [adminPasscode, toast]);

  // --- Batch mode ---
  const BATCH_JOBS_KEY = "phdata-batch-jobs";

  interface StoredBatchJob {
    id: string;
    batchId: string | null;
    fileName: string;
    rowCount: number;
    submittedAt: number;
    csvText: string;
    preResolved: Record<number, MatchResult>;
  }

  const [batchMode, setBatchMode] = useState(false);
  const [batchJobs, setBatchJobs] = useState<StoredBatchJob[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(BATCH_JOBS_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  const [checkingBatch, setCheckingBatch] = useState<string | null>(null);

  const saveBatchJobs = useCallback((jobs: StoredBatchJob[]) => {
    setBatchJobs(jobs);
    localStorage.setItem(BATCH_JOBS_KEY, JSON.stringify(jobs));
  }, []);

  const submitBatch = useCallback(
    async (file: File) => {
      const passcode = adminPasscode.trim();
      if (!passcode) {
        toast({ title: "Admin passcode required", description: "Enter the admin passcode to submit a batch job.", variant: "destructive" });
        return;
      }
      setError(null);
      setProcessing(true);
      setProgress(0);
      try {
        const csvText = await file.text();
        const { rows } = parseCsvText(csvText);
        if (rows.length === 0) throw new Error("No rows detected in CSV.");
        if (rows.length > 2000) throw new Error("Batch limit is 2000 rows.");

        const res = await apiRequest("POST", "/api/match/batch", { rows, fileName: file.name }, { "x-admin-passcode": passcode });
        const data = await res.json() as {
          batchId: string | null;
          rowCount: number;
          preResolved: Record<number, MatchResult>;
          fileName: string;
          allPreResolved: boolean;
        };

        const job: StoredBatchJob = {
          id: crypto.randomUUID(),
          batchId: data.batchId,
          fileName: file.name,
          rowCount: data.rowCount,
          submittedAt: Date.now(),
          csvText,
          preResolved: data.preResolved ?? {},
        };
        saveBatchJobs([job, ...batchJobs]);
        toast({ title: "Batch submitted", description: `${data.rowCount} candidates queued. Check status in the Batch jobs panel.` });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Batch submission failed.");
      } finally {
        setProcessing(false);
      }
    },
    [adminPasscode, batchJobs, saveBatchJobs, toast],
  );

  const checkBatchJob = useCallback(
    async (job: StoredBatchJob) => {
      const passcode = adminPasscode.trim();
      if (!passcode) return;
      if (!job.batchId) return;
      setCheckingBatch(job.id);
      try {
        const res = await apiRequest("GET", `/api/match/batch/${job.batchId}`, undefined, { "x-admin-passcode": passcode });
        const data = await res.json() as {
          status: string;
          results: Record<number, MatchResult> | null;
        };

        if (data.status !== "ended" || !data.results) {
          toast({ title: "Still processing", description: `Status: ${data.status}. Check back in a few minutes.` });
          return;
        }

        // Merge batch results with pre-resolved hard-block results, then display.
        const { headers, rows } = parseCsvText(job.csvText);
        const exportHeaders = buildExportHeaders(headers);
        const results: MatchResult[] = rows.map((_, i) =>
          (job.preResolved[i] ?? data.results![i]) as MatchResult,
        );
        const exportRows = rows.map((row, i) =>
          buildExportRow(row, results[i], headers),
        );
        setState({ inputHeaders: headers, inputRows: rows, results, exportHeaders, exportRows, fileName: job.fileName });
        toast({ title: "Batch complete", description: `${job.rowCount} candidates scored. Results loaded below.` });
      } catch {
        toast({ title: "Check failed", description: "Could not retrieve batch results.", variant: "destructive" });
      } finally {
        setCheckingBatch(null);
      }
    },
    [adminPasscode, toast],
  );

  const byDept = useMemo(() => {
    const m = new Map<string, RoleLibraryJob[]>();
    for (const j of jobs) {
      if (!m.has(j.department)) m.set(j.department, []);
      m.get(j.department)!.push(j);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [jobs]);

  const byRegion = useMemo(() => {
    const m = new Map<string, number>();
    for (const j of jobs) m.set(j.region, (m.get(j.region) || 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [jobs]);

  const processFile = useCallback(
    async (file: File) => {
      setError(null);
      setProcessing(true);
      setProgress(0);
      setState(null);
      try {
        const text = await file.text();
        const { headers, rows } = parseCsvText(text);
        if (rows.length === 0) {
          throw new Error(
            "No rows detected. Verify the CSV has a header row and at least one data row.",
          );
        }
        const exportHeaders = buildExportHeaders(headers);
        const results: MatchResult[] = new Array(rows.length);
        const exportRows: string[][] = new Array(rows.length);
        const runId =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const effectiveAdminPasscode = adminPasscode.trim();

        const calibrationMap =
          effectiveAdminPasscode
            ? latestCalibrationMap(await loadCalibrations(effectiveAdminPasscode))
            : new Map<string, CalibrationResponse>();

        // Send candidates to the server-side LLM matcher in parallel batches.
        let completed = 0;
        const CONCURRENCY = 5;
        for (let i = 0; i < rows.length; i += CONCURRENCY) {
          const chunk = rows.slice(i, Math.min(i + CONCURRENCY, rows.length));
          await Promise.all(
            chunk.map(async (r, offset) => {
              const idx = i + offset;
              const matchRes = await apiRequest("POST", "/api/match", { row: r });
              const baseMatch = (await matchRes.json()) as MatchResult;
              const m = applyCalibrationResponse(
                baseMatch,
                calibrationMap.get(candidateKeyForRow(r)),
              );
              results[idx] = m;
              exportRows[idx] = buildExportRow(r, m, headers);
              completed++;
              setProgress(Math.round((completed / rows.length) * 100));
            }),
          );
        }

        const exportCsv = rowsToCsv(exportHeaders, exportRows);
        const baseName = file.name.replace(/\.csv$/i, "");

        if (effectiveAdminPasscode) {
        try {
          await Promise.all([
            apiRequest("POST", "/api/saved-files", {
              runId,
              kind: "upload",
              fileName: file.name,
              rowCount: rows.length,
              columnCount: headers.length,
              csvText: text,
            }, { "x-admin-passcode": effectiveAdminPasscode }),
            apiRequest("POST", "/api/saved-files", {
              runId,
              kind: "export",
              fileName: `${baseName}__phData-scored.csv`,
              rowCount: rows.length,
              columnCount: exportHeaders.length,
              csvText: exportCsv,
            }, { "x-admin-passcode": effectiveAdminPasscode }),
          ]);
          queryClient.invalidateQueries({ queryKey: ["/api/saved-files"] });
          queryClient.invalidateQueries({ queryKey: ["/api/calibrations"] });
        } catch (saveErr) {
          console.warn("Could not save upload/export history", saveErr);
          toast({
            title: "Processed, but history was not saved",
            description:
              saveErr instanceof Error ? saveErr.message : "Could not save files for later download.",
            variant: "destructive",
          });
        }
        } else {
          toast({
            title: "Processed without saving history",
            description: "Enter the admin passcode before uploading if you want uploads and exports saved for later.",
          });
        }

        setState({
          inputHeaders: headers,
          inputRows: rows,
          results,
          exportHeaders,
          exportRows,
          fileName: baseName,
        });
        toast({
          title: "Processing complete",
          description: `Scored ${rows.length} candidates for departmental alignment.`,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to parse CSV";
        setError(msg);
        toast({
          title: "Could not process CSV",
          description: msg,
          variant: "destructive",
        });
      } finally {
        setProcessing(false);
      }
    },
    [adminPasscode, toast],
  );

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) batchMode ? submitBatch(f) : processFile(f);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) batchMode ? submitBatch(f) : processFile(f);
  };

  const onDownload = () => {
    if (!state) return;
    const csv = rowsToCsv(state.exportHeaders, state.exportRows);
    downloadCsv(`${state.fileName}__phData-scored.csv`, csv);
  };

  const onDownloadSaved = async (id: string) => {
    try {
      const res = await apiRequest("GET", `/api/saved-files/${id}`, undefined, {
        "x-admin-passcode": adminPasscode.trim(),
      });
      const file = await res.json();
      downloadCsv(file.fileName, file.csvText);
    } catch (err) {
      toast({
        title: "Could not download saved file",
        description: err instanceof Error ? err.message : "Try refreshing the saved files list.",
        variant: "destructive",
      });
    }
  };

  const onSaveCalibration = async (
    rowIndex: number,
    isCorrect: boolean,
    correctedDepartment: string,
    _correctedRole: string,
    feedbackReason: string,
  ) => {
    if (!state) return;
    const effectiveAdminPasscode = adminPasscode.trim();
    if (!effectiveAdminPasscode) {
      toast({
        title: "Admin passcode required",
        description: "Enter the admin passcode to save calibration feedback.",
        variant: "destructive",
      });
      return;
    }
    const row = state.inputRows[rowIndex];
    const match = state.results[rowIndex];

    try {
      const res = await apiRequest("POST", "/api/calibrations", {
        candidateKey: candidateKeyForRow(row),
        candidateName: candidateDisplayName(row, rowIndex),
        originalDepartment: match.department,
        originalRole: "",
        originalConfidence: typeof match.confidence === "number" ? match.confidence : 0,
        isCorrect,
        correctedDepartment: isCorrect ? match.department : correctedDepartment.trim(),
        correctedRole: "",
        feedbackReason: feedbackReason.trim(),
      }, {
        "x-admin-passcode": effectiveAdminPasscode,
      });
      const saved = (await res.json()) as CalibrationResponse;
      queryClient.invalidateQueries({ queryKey: ["/api/calibrations"] });

      if (!isCorrect) {
        const nextResults = [...state.results];
        const nextMatch = applyCalibrationResponse(match, saved);
        nextResults[rowIndex] = nextMatch;
        const nextExportRows = [...state.exportRows];
        nextExportRows[rowIndex] = buildExportRow(row, nextMatch, state.inputHeaders);
        setState({ ...state, results: nextResults, exportRows: nextExportRows });
      }

      toast({
        title: isCorrect ? "Calibration saved: correct" : "Calibration saved: corrected",
        description: isCorrect
          ? "Future reviews will remember this was a good match."
          : "Future uploads for this candidate will use your corrected match.",
      });
    } catch (err) {
      toast({
        title: "Could not save calibration",
        description: err instanceof Error ? err.message : "Check the admin passcode and try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {/* Header */}
      <header className="border-b border-[#244967]/20 bg-[#244967] text-white sticky top-0 z-10 shadow-sm">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <PhDataMark className="h-9 w-9 text-[#39d3ad]" />
            <div>
              <h1
                className="text-lg font-semibold tracking-tight"
                data-testid="text-app-title"
              >
                phData Match
              </h1>
              <p className="text-xs text-white/70 font-mono">
                candidate → department · LLM-powered matching
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-[11px] border-white/20 text-white bg-white/5" data-testid="badge-jobs-count">
              {libraryQ.isLoading ? "…" : `${jobs.length} roles`}
            </Badge>
            <Badge variant="outline" className="font-mono text-[11px] border-white/20 text-white bg-white/5">
              {byDept.length} departments
            </Badge>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left column: role library */}
        <section className="lg:col-span-4 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Layers className="h-4 w-4" /> Role Library
          </h2>

          <Card data-testid="card-region-summary">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <MapPin className="h-4 w-4" /> By Region
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {byRegion.map(([region, count]) => (
                <div
                  key={region}
                  className="flex items-center justify-between text-sm"
                  data-testid={`region-${region}`}
                >
                  <span className="font-mono text-muted-foreground">{region}</span>
                  <span className="font-mono tabular-nums">{count}</span>
                </div>
              ))}
              {byRegion.length === 0 && (
                <p className="text-xs text-muted-foreground">Loading…</p>
              )}
            </CardContent>
          </Card>

          <Card data-testid="card-saved-files">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Archive className="h-4 w-4" /> Shared saved files
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => savedFilesQ.refetch()}
                  disabled={!adminPasscode.trim()}
                  data-testid="button-refresh-saved-files"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="space-y-1.5">
                <Input
                  type="password"
                  value={adminPasscode}
                  onChange={(e) => {
                    setAdminPasscode(e.target.value);
                  }}
                  placeholder="Admin passcode"
                  className="h-8 text-xs font-mono"
                  data-testid="input-admin-passcode"
                  spellCheck={false}
                />
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    One admin passcode unlocks the shared upload/export history
                    and shared calibration feedback from any computer.
                  </p>
                </div>
                {adminPasscode.trim() && (
                  <p className="rounded-md bg-primary/5 px-2 py-1 text-[11px] text-primary flex items-center gap-1.5">
                    <LockKeyhole className="h-3 w-3" />
                    Shared history is unlocked for this browser session.
                  </p>
                )}
              </div>
              {adminPasscode.trim() && (
                <div
                  className="space-y-1.5 rounded-md border border-border/70 bg-background/60 p-2"
                  data-testid="card-role-sync"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold flex items-center gap-1.5">
                      <RefreshCw className="h-3.5 w-3.5" />
                      Live phData roles
                    </p>
                    <Button
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={onRunRoleSync}
                      disabled={syncing}
                      data-testid="button-sync-roles"
                    >
                      {syncing ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1 h-3.5 w-3.5" />
                      )}
                      {syncing ? "Syncing…" : "Sync now"}
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Pulls current open phData jobs from the public Greenhouse
                    board. Historical roles stay in the library; matched
                    candidates can still hit past openings.
                  </p>
                  {roleSyncStatusQ.data && (
                    <div className="text-[11px] font-mono text-muted-foreground space-y-0.5">
                      <div>
                        bundled {roleSyncStatusQ.data.bundledRolesCount} ·
                        active synced {roleSyncStatusQ.data.syncedRolesActive} ·
                        total synced {roleSyncStatusQ.data.syncedRolesTotal}
                      </div>
                      {roleSyncStatusQ.data.lastRun ? (
                        <div data-testid="text-last-sync">
                          last sync{" "}
                          {formatSavedDate(roleSyncStatusQ.data.lastRun.finishedAt)}
                          {" · "}
                          {roleSyncStatusQ.data.lastRun.status}
                          {" · "}
                          new {roleSyncStatusQ.data.lastRun.rolesNew} /
                          upd {roleSyncStatusQ.data.lastRun.rolesUpdated} /
                          deact {roleSyncStatusQ.data.lastRun.rolesDeactivated}
                        </div>
                      ) : (
                        <div>no sync run yet</div>
                      )}
                    </div>
                  )}
                  {lastSyncResult && lastSyncResult.status !== "error" && (
                    <div className="text-[11px] text-muted-foreground space-y-0.5">
                      <div>
                        Last run: {lastSyncResult.rolesFound} found,{" "}
                        <span className="text-primary font-medium">
                          {lastSyncResult.rolesNew} new
                        </span>
                        , {lastSyncResult.rolesUpdated} already known,{" "}
                        {lastSyncResult.rolesDeactivated} deactivated.
                      </div>
                      {lastSyncResult.newRoles.length > 0 && (
                        <div className="font-mono">
                          new:{" "}
                          {lastSyncResult.newRoles
                            .slice(0, 5)
                            .map((r) => `${r.department}/${r.title}`)
                            .join(" · ")}
                          {lastSyncResult.newRoles.length > 5 ? " …" : ""}
                        </div>
                      )}
                    </div>
                  )}
                  {lastSyncResult && lastSyncResult.status === "error" && (
                    <p className="text-[11px] text-destructive" data-testid="text-sync-error">
                      Error: {lastSyncResult.errorMessage}
                    </p>
                  )}
                </div>
              )}
              {adminPasscode.trim() && correctionCount > 0 && (
                <div
                  className={`space-y-2 rounded-md border p-2 ${
                    correctionCount >= 50
                      ? "border-amber-500/60 bg-amber-500/5"
                      : "border-border/70 bg-background/60"
                  }`}
                  data-testid="card-calibration-intelligence"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold flex items-center gap-1.5">
                      <SlidersHorizontal className="h-3.5 w-3.5" />
                      Calibration intelligence
                      {correctionCount >= 50 && (
                        <span className="ml-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600">
                          TIPPING POINT
                        </span>
                      )}
                    </p>
                    <Button
                      size="sm"
                      variant={correctionCount >= 50 ? "default" : "outline"}
                      className="h-7 px-2 text-xs"
                      onClick={onRunAnalysis}
                      disabled={analysisRunning}
                    >
                      {analysisRunning ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="mr-1 h-3.5 w-3.5" />
                      )}
                      {analysisRunning ? "Analyzing…" : "Run Analysis"}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          correctionCount >= 50 ? "bg-amber-500" : "bg-primary/60"
                        }`}
                        style={{ width: `${Math.min(100, (correctionCount / 50) * 100)}%` }}
                      />
                    </div>
                    <span className="text-[11px] font-mono text-muted-foreground whitespace-nowrap">
                      {correctionCount} / 50 corrections
                    </span>
                  </div>
                  {correctionCount >= 50 && !analysisText && (
                    <p className="text-[11px] text-amber-700 leading-relaxed">
                      You have enough recruiter corrections to identify systemic misrouting patterns. Run the analysis to get specific prompt boundary update recommendations.
                      {process.env.SLACK_WEBHOOK_URL !== undefined && " Results will also be sent to Slack."}
                    </p>
                  )}
                  {analysisText && (
                    <div className="rounded-md border border-border/60 bg-background p-2 space-y-1">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Analysis
                      </p>
                      <p className="text-xs leading-relaxed whitespace-pre-wrap">{analysisText}</p>
                    </div>
                  )}
                </div>
              )}
              {adminPasscode.trim() && batchJobs.length > 0 && (
                <div className="space-y-1.5 rounded-md border border-border/70 bg-background/60 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold flex items-center gap-1.5">
                      <Archive className="h-3.5 w-3.5" /> Batch jobs
                    </p>
                    <button
                      type="button"
                      className="text-[10px] text-muted-foreground hover:text-foreground"
                      onClick={() => saveBatchJobs([])}
                    >
                      Clear all
                    </button>
                  </div>
                  {batchJobs.slice(0, 5).map((job) => (
                    <div key={job.id} className="rounded border border-border/50 bg-background p-1.5 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] font-medium truncate flex-1" title={job.fileName}>
                          {job.fileName}
                        </p>
                        <span className="text-[10px] font-mono text-muted-foreground whitespace-nowrap">
                          {job.rowCount} rows
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(job.submittedAt).toLocaleString()}
                        </span>
                        {job.batchId ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px]"
                            onClick={() => checkBatchJob(job)}
                            disabled={checkingBatch === job.id}
                          >
                            {checkingBatch === job.id ? (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            ) : (
                              <RefreshCw className="mr-1 h-3 w-3" />
                            )}
                            {checkingBatch === job.id ? "Checking…" : "Check & Load"}
                          </Button>
                        ) : (
                          <span className="text-[10px] text-muted-foreground italic">all pre-resolved</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {adminPasscode.trim() && savedFilesQ.isLoading && (
                <p className="text-xs text-muted-foreground font-mono">
                  Loading saved files…
                </p>
              )}
              {!adminPasscode.trim() && (
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Enter the admin passcode to load every saved upload and export.
                  Uploads can still be scored without it, but they will not be
                  saved for later.
                </p>
              )}
              {adminPasscode.trim() &&
                !savedFilesQ.isLoading &&
                (savedFilesQ.data || []).length === 0 && (
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Process a CSV and the original upload plus the scored export
                  will be saved here for later re-download.
                </p>
              )}
              {(savedFilesQ.data || []).slice(0, 8).map((file) => (
                <div
                  key={file.id}
                  className="rounded-md border border-border/70 bg-background/60 p-2"
                  data-testid={`saved-file-${file.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Badge
                          variant={file.kind === "export" ? "default" : "outline"}
                          className="h-5 px-1.5 text-[10px] uppercase"
                        >
                          {file.kind}
                        </Badge>
                        <p
                          className="truncate text-xs font-medium"
                          title={file.fileName}
                        >
                          {file.fileName}
                        </p>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground font-mono">
                        {file.rowCount} rows · {file.columnCount} cols ·{" "}
                        {formatBytes(file.byteSize)} ·{" "}
                        {formatSavedDate(file.createdAt)}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-xs"
                      onClick={() => onDownloadSaved(file.id)}
                      data-testid={`button-download-saved-${file.id}`}
                    >
                      <Download className="mr-1 h-3.5 w-3.5" /> CSV
                    </Button>
                  </div>
                </div>
              ))}
              {(savedFilesQ.data || []).length > 8 && (
                <p className="text-[11px] text-muted-foreground font-mono">
                  Showing 8 most recent of {savedFilesQ.data?.length} saved
                  files.
                </p>
              )}
            </CardContent>
          </Card>

          <Card data-testid="card-department-summary">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Briefcase className="h-4 w-4" /> By Department
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {byDept.map(([dept, ds]) => (
                  <div
                    key={dept}
                    data-testid={`dept-card-${dept.replace(/[^A-Za-z]/g, "")}`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="text-sm font-medium">{dept}</h3>
                      <Badge variant="secondary" className="font-mono">
                        {ds.length}
                      </Badge>
                    </div>
                    <ul className="space-y-0.5">
                      {ds.slice(0, 5).map((j) => (
                        <li
                          key={j.file}
                          className="grid grid-cols-[0.75rem_1fr] gap-1 text-xs text-muted-foreground font-mono leading-relaxed hover:text-foreground"
                          title={`${j.title} — ${j.location}`}
                        >
                          <span aria-hidden="true">·</span>
                          <span className="min-w-0 break-words">
                            {j.title}
                            <span className="opacity-50"> · {j.region}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                    {ds.length > 5 && (
                      <p className="mt-1 text-[11px] font-mono text-muted-foreground">
                        + {ds.length - 5} more role{ds.length - 5 === 1 ? "" : "s"}
                      </p>
                    )}
                    <Separator className="mt-3" />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Confidence legend</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <ConfidenceRow level={2} label="Confident — route without review" />
              <ConfidenceRow level={1} label="Low confidence — recruiter should review" />
              <div className="flex items-center gap-2" data-testid="legend-confidence-na">
                <span className="inline-flex h-5 min-w-8 items-center justify-center rounded bg-destructive/10 px-1 font-mono text-[11px] font-semibold text-destructive">
                  N/A
                </span>
                <span className="text-muted-foreground">Not applicable for phData</span>
              </div>
              <div className="flex items-center gap-2" data-testid="legend-confidence-question">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-muted px-1 font-mono text-[11px] font-semibold text-muted-foreground">
                  ?
                </span>
                <span className="text-muted-foreground">Insufficient data either way</span>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Right column: upload + processing + results */}
        <section className="lg:col-span-8 space-y-6">
          <Card data-testid="card-upload">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between gap-2 text-base">
                <span className="flex items-center gap-2">
                  <Upload className="h-4 w-4" /> Upload Candidate CSV
                </span>
                {adminPasscode.trim() && (
                  <button
                    type="button"
                    onClick={() => setBatchMode((m) => !m)}
                    className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      batchMode
                        ? "bg-amber-500/15 text-amber-700 ring-1 ring-amber-500/40"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}
                    title={batchMode ? "Switch to real-time scoring" : "Switch to batch scoring (50% off, ~1 hr)"}
                  >
                    {batchMode ? <Archive className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
                    {batchMode ? "Batch mode (50% off)" : "Real-time"}
                  </button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <label
                htmlFor="csv-file"
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                className={`block border-2 border-dashed rounded-md p-8 text-center cursor-pointer transition-colors ${
                  dragOver
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/60"
                }`}
                data-testid="dropzone-csv"
              >
                <FileSpreadsheet className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
                <p className="text-sm">
                  <span className="font-medium">Click to choose</span> or drag and
                  drop a LinkedIn export CSV
                </p>
                <p className="text-xs text-muted-foreground mt-1 font-mono">
                  template export columns · department evaluation columns appended · LLM-scored server-side
                </p>
                <input
                  id="csv-file"
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={onFileChange}
                  data-testid="input-csv-file"
                />
              </label>

              {processing && (
                <div className="mt-4" data-testid="status-processing">
                  <div className="flex items-center justify-between text-xs mb-2 font-mono">
                    <span className="flex items-center gap-2">
                      <Loader2 className="h-3 w-3 animate-spin" /> scoring
                      candidates…
                    </span>
                    <span>{progress}%</span>
                  </div>
                  <Progress value={progress} />
                </div>
              )}

              {error && (
                <div
                  className="mt-4 flex items-start gap-2 text-sm text-destructive border border-destructive/40 rounded-md p-3 bg-destructive/5"
                  data-testid="status-error"
                >
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {state && (
            <>
              <Card data-testid="card-column-mapping">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-primary" /> Output
                      columns
                    </span>
                    <span className="text-xs text-muted-foreground font-mono font-normal">
                      {state.inputHeaders.length} input columns →{" "}
                      {state.exportHeaders.length} template/export columns
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <div className="text-xs font-mono text-muted-foreground mb-2">
                        Template columns populated from inferred candidate fields
                      </div>
                      <div className="flex flex-wrap gap-2" data-testid="list-template-columns">
                        {COLUMN_TEMPLATE.slice(0, 18).map((h, i) => (
                          <Badge key={`${h}-${i}`} variant="outline" className="font-mono">
                            {h}
                          </Badge>
                        ))}
                        {COLUMN_TEMPLATE.length > 18 && (
                          <Badge variant="secondary" className="font-mono">
                            +{COLUMN_TEMPLATE.length - 18} more
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-mono text-muted-foreground mb-2">
                        Only these department evaluation fields are appended
                      </div>
                      <div className="grid gap-2" data-testid="list-appended-columns">
                        {APPENDED_COLUMNS.map((h) => (
                          <div
                            key={h}
                            className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs font-mono text-primary"
                          >
                            {h}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="card-results">
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-primary" /> Review & calibrate results
                    </CardTitle>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Review every candidate, mark the model right or wrong, and save corrections for future uploads.
                    </p>
                  </div>
                  <Button onClick={onDownload} size="sm" data-testid="button-download-csv">
                    <Download className="h-4 w-4 mr-1.5" /> Download scored CSV
                  </Button>
                </CardHeader>
                <CardContent>
                  <ResultsTable
                    state={state}
                    calibrationsByKey={latestCalibrationByKey}
                    onSaveCalibration={onSaveCalibration}
                  />
                </CardContent>
              </Card>
            </>
          )}

          {!state && !processing && (
            <Card data-testid="card-workflow-helper">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" /> Scoring workflow
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid sm:grid-cols-3 gap-3 text-sm">
                  {[
                    ["Evaluate", "Claude reads the candidate's actual work history and what they do — not just tool keywords — to route them to the right department."],
                    ["Route", "Candidates are routed to departments only; specific role fit is no longer exported. Calibration corrections are applied on top."],
                    ["Export", "Download the template-shaped file with department score, rationale, and department fit appended."],
                  ].map(([label, text]) => (
                    <div
                      key={label}
                      className="rounded-md border border-border/70 bg-background/50 p-3"
                    >
                      <div className="font-mono text-xs text-primary mb-1">
                        {label}
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {text}
                      </p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </section>
      </main>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatSavedDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "unknown date";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function loadCalibrations(adminPasscode: string): Promise<CalibrationResponse[]> {
  if (!adminPasscode.trim()) return [];
  const res = await apiRequest("GET", "/api/calibrations", undefined, {
    "x-admin-passcode": adminPasscode.trim(),
  });
  return res.json();
}

function latestCalibrationMap(calibrations: CalibrationResponse[]): Map<string, CalibrationResponse> {
  const map = new Map<string, CalibrationResponse>();
  for (const calibration of calibrations) {
    const existing = map.get(calibration.candidateKey);
    if (!existing || calibration.createdAt > existing.createdAt) {
      map.set(calibration.candidateKey, calibration);
    }
  }
  return map;
}

function candidateDisplayName(row: Record<string, string>, index = 0): string {
  return (
    Object.entries(row).find(([k]) => /full\s*name|^name$/i.test(k))?.[1]?.trim() ||
    Object.entries(row).find(([k]) => /linkedin/i.test(k))?.[1]?.trim() ||
    `row ${index + 1}`
  );
}

function candidateKeyForRow(row: Record<string, string>): string {
  const linkedIn = Object.entries(row).find(([k]) => /linkedin/i.test(k))?.[1]?.trim();
  if (linkedIn) return `linkedin:${linkedIn.toLowerCase().replace(/\/+$/, "")}`;
  const name = candidateDisplayName(row).toLowerCase();
  const title = Object.entries(row).find(([k]) => /title/i.test(k))?.[1]?.trim().toLowerCase() || "";
  const company = Object.entries(row).find(([k]) => /company/i.test(k))?.[1]?.trim().toLowerCase() || "";
  return `profile:${name}|${title}|${company}`;
}

function applyCalibrationResponse(
  match: MatchResult,
  calibration: CalibrationResponse | undefined,
): MatchResult {
  if (!calibration || calibration.isCorrect === 1) return match;
  const department = calibration.correctedDepartment || match.department;
  const confidence: 1 | 2 | 3 | "N/A" | "?" =
    department.startsWith("Not a Match") ? "N/A" : department === "Needs human review" ? "?" : 2;
  return {
    ...match,
    department,
    role: "",
    confidence,
    rationale: calibration.feedbackReason
      ? `Calibration override: ${calibration.feedbackReason}`
      : "Calibration override applied from recruiter feedback.",
  };
}

function ConfidenceRow({
  level,
  label,
}: {
  level: 1 | 2;
  label: string;
}) {
  const colors = {
    1: "bg-muted text-muted-foreground",
    2: "bg-primary/20 text-primary",
  } as const;
  return (
    <div className="flex items-center gap-2" data-testid={`legend-confidence-${level}`}>
      <span
        className={`inline-flex h-5 w-5 items-center justify-center rounded font-mono text-[11px] font-semibold ${colors[level]}`}
      >
        {level}
      </span>
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

function ResultsTable({
  state,
  calibrationsByKey,
  onSaveCalibration,
}: {
  state: ProcessedState;
  calibrationsByKey: Map<string, CalibrationResponse>;
  onSaveCalibration: (
    rowIndex: number,
    isCorrect: boolean,
    correctedDepartment: string,
    correctedRole: string,
    feedbackReason: string,
  ) => Promise<void>;
}) {
  const PAGE_SIZE = 50;
  const [activeCalibrationRow, setActiveCalibrationRow] = useState<number | null>(null);
  const [correctedDepartment, setCorrectedDepartment] = useState("");
  const [feedbackReason, setFeedbackReason] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);
  const [reviewRowIndex, setReviewRowIndex] = useState<number | null>(null);
  const [bulkSaving, setBulkSaving] = useState(false);

  const rowsWithMeta = useMemo(
    () =>
      state.inputRows.map((row, rowIndex) => {
        const match = state.results[rowIndex];
        const candidateKey = candidateKeyForRow(row);
        const calibration = calibrationsByKey.get(candidateKey);
        const haystack = [
          candidateDisplayName(row, rowIndex),
          match.department,
          match.rationale,
          ...Object.values(row),
        ]
          .join(" ")
          .toLowerCase();
        return { row, rowIndex, match, candidateKey, calibration, haystack };
      }),
    [state.inputRows, state.results, calibrationsByKey],
  );

  const totalRows = rowsWithMeta.length;
  const correctCount = rowsWithMeta.filter((item) => item.calibration?.isCorrect === 1).length;
  const correctedCount = rowsWithMeta.filter((item) => item.calibration?.isCorrect === 0).length;
  const reviewedCount = correctCount + correctedCount;

  const filteredRows = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    return rowsWithMeta.filter((item) => {
      const matchesSearch = !normalizedSearch || item.haystack.includes(normalizedSearch);
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "unreviewed" && !item.calibration) ||
        (statusFilter === "correct" && item.calibration?.isCorrect === 1) ||
        (statusFilter === "corrected" && item.calibration?.isCorrect === 0) ||
        (statusFilter === "no-match" && item.match.department.startsWith("Not a Match")) ||
        (statusFilter === "needs-review" && item.match.department === "Needs human review");
      return matchesSearch && matchesStatus;
    });
  }, [rowsWithMeta, searchTerm, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pagedRows = filteredRows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const startRow = filteredRows.length ? safePage * PAGE_SIZE + 1 : 0;
  const endRow = Math.min((safePage + 1) * PAGE_SIZE, filteredRows.length);

  const updateSearch = (value: string) => {
    setSearchTerm(value);
    setPage(0);
    setActiveCalibrationRow(null);
    setSelectedRowIndex(null);
  };

  const updateStatusFilter = (value: string) => {
    setStatusFilter(value);
    setPage(0);
    setActiveCalibrationRow(null);
    setSelectedRowIndex(null);
  };

  const openCalibration = (rowIndex: number, match: MatchResult) => {
    setActiveCalibrationRow(activeCalibrationRow === rowIndex ? null : rowIndex);
    setSelectedRowIndex(rowIndex);
    setCorrectedDepartment(match.department);
    setFeedbackReason("");
  };

  const openReviewPanel = (rowIndex: number, match: MatchResult) => {
    setReviewRowIndex(rowIndex);
    setSelectedRowIndex(rowIndex);
    setActiveCalibrationRow(null);
    setCorrectedDepartment(match.department);
    setFeedbackReason("");
  };

  const saveCorrection = async (rowIndex: number) => {
    await onSaveCalibration(
      rowIndex,
      false,
      correctedDepartment,
      "",
      feedbackReason,
    );
    setActiveCalibrationRow(null);
    setFeedbackReason("");
    setReviewRowIndex(null);
  };

  const selectRelativeRow = useCallback(
    (direction: 1 | -1) => {
      if (!pagedRows.length) return;
      const currentPosition =
        selectedRowIndex === null
          ? -1
          : pagedRows.findIndex((item) => item.rowIndex === selectedRowIndex);
      const nextPosition =
        currentPosition === -1
          ? direction === 1
            ? 0
            : pagedRows.length - 1
          : Math.min(pagedRows.length - 1, Math.max(0, currentPosition + direction));
      const nextRowIndex = pagedRows[nextPosition]?.rowIndex;
      if (nextRowIndex === undefined) return;
      setSelectedRowIndex(nextRowIndex);
      setActiveCalibrationRow(null);
      window.setTimeout(() => {
        document
          .querySelector(`[data-testid="result-row-${nextRowIndex}"]`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }, 0);
    },
    [pagedRows, selectedRowIndex],
  );

  const goToNextUnreviewed = useCallback(() => {
    const start = selectedRowIndex ?? -1;
    const next = filteredRows.find((item) => item.rowIndex > start && !item.calibration);
    const fallback = filteredRows.find((item) => !item.calibration);
    const target = next || fallback;
    if (!target) return;
    const targetPage = Math.floor(filteredRows.indexOf(target) / PAGE_SIZE);
    setPage(targetPage);
    setSelectedRowIndex(target.rowIndex);
    setActiveCalibrationRow(null);
    window.setTimeout(() => {
      document
        .querySelector(`[data-testid="result-row-${target.rowIndex}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 0);
  }, [filteredRows, selectedRowIndex]);

  const selectedItem = selectedRowIndex === null ? null : rowsWithMeta.find((item) => item.rowIndex === selectedRowIndex);
  const reviewItem = reviewRowIndex === null ? null : rowsWithMeta.find((item) => item.rowIndex === reviewRowIndex);

  const markCurrentPageCorrect = async () => {
    const targets = pagedRows.filter((item) => !item.calibration);
    if (!targets.length) return;
    const ok = window.confirm(
      `Mark ${targets.length} unreviewed candidate${targets.length === 1 ? "" : "s"} on this page as correct?`,
    );
    if (!ok) return;
    setBulkSaving(true);
    try {
      for (const item of targets) {
        await onSaveCalibration(
          item.rowIndex,
          true,
          item.match.department,
          "",
          "Bulk marked correct by recruiter.",
        );
      }
    } finally {
      setBulkSaving(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "j" || key === "arrowdown") {
        event.preventDefault();
        selectRelativeRow(1);
      } else if (key === "k" || key === "arrowup") {
        event.preventDefault();
        selectRelativeRow(-1);
      } else if (key === "n") {
        event.preventDefault();
        goToNextUnreviewed();
      } else if (key === "c" && selectedItem) {
        event.preventDefault();
        onSaveCalibration(
          selectedItem.rowIndex,
          true,
          selectedItem.match.department,
          "",
          "Marked correct by recruiter.",
        );
      } else if (key === "f" && selectedItem) {
        event.preventDefault();
        openCalibration(selectedItem.rowIndex, selectedItem.match);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goToNextUnreviewed, onSaveCalibration, openCalibration, selectRelativeRow, selectedItem]);

  return (
    <>
      <div className="mb-3 grid gap-3 lg:grid-cols-[1fr_auto]">
        <div className="grid gap-2 sm:grid-cols-[1fr_190px]">
          <Input
            value={searchTerm}
            onChange={(e) => updateSearch(e.target.value)}
            placeholder="Search by candidate, title, company, department, or rationale"
            className="h-9 text-xs"
            data-testid="input-results-search"
          />
          <select
            value={statusFilter}
            onChange={(e) => updateStatusFilter(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-xs text-foreground shadow-sm"
            data-testid="select-calibration-status"
          >
            <option value="all">All results</option>
            <option value="unreviewed">Needs review</option>
            <option value="correct">Marked correct</option>
            <option value="corrected">Corrected</option>
            <option value="no-match">No match only</option>
            <option value="needs-review">Needs human review</option>
          </select>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-md border border-border bg-background/60 px-3 py-2" data-testid="metric-total-results">
            <div className="font-mono text-muted-foreground">Rows</div>
            <div className="font-semibold">{totalRows}</div>
          </div>
          <div className="rounded-md border border-border bg-background/60 px-3 py-2" data-testid="metric-reviewed-results">
            <div className="font-mono text-muted-foreground">Reviewed</div>
            <div className="font-semibold">{reviewedCount}</div>
          </div>
          <div className="rounded-md border border-border bg-background/60 px-3 py-2" data-testid="metric-corrected-results">
            <div className="font-mono text-muted-foreground">Corrected</div>
            <div className="font-semibold">{correctedCount}</div>
          </div>
        </div>
      </div>
      <div className="mb-3 flex flex-col gap-2 rounded-lg border border-border bg-background/60 p-3 text-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="font-semibold text-foreground">Fast calibration</div>
          <div className="text-muted-foreground">
            Shortcuts: <kbd className="rounded border px-1 font-mono">J</kbd>/<kbd className="rounded border px-1 font-mono">K</kbd> move,{" "}
            <kbd className="rounded border px-1 font-mono">C</kbd> correct,{" "}
            <kbd className="rounded border px-1 font-mono">F</kbd> fix,{" "}
            <kbd className="rounded border px-1 font-mono">N</kbd> next unreviewed.
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={goToNextUnreviewed}
            disabled={!filteredRows.some((item) => !item.calibration)}
            data-testid="button-next-unreviewed"
          >
            Next unreviewed
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={markCurrentPageCorrect}
            disabled={bulkSaving || !pagedRows.some((item) => !item.calibration)}
            data-testid="button-bulk-mark-page-correct"
          >
            {bulkSaving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
            Mark page correct
          </Button>
        </div>
      </div>

      <div className="h-[460px] overflow-auto rounded-lg border border-border bg-card/40" data-testid="results-scroll-container">
        <table className="min-w-[960px] w-full text-xs border-separate border-spacing-0">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border">
              <th className="sticky top-0 z-20 bg-card text-left py-2 pr-3 font-mono border-b border-border shadow-[0_1px_0_hsl(var(--border))]">#</th>
              <th className="sticky top-0 z-20 bg-card text-left py-2 pr-3 border-b border-border shadow-[0_1px_0_hsl(var(--border))]">Candidate</th>
              <th className="sticky top-0 z-20 bg-card text-left py-2 pr-3 border-b border-border shadow-[0_1px_0_hsl(var(--border))]">Department</th>
              <th className="sticky top-0 z-20 bg-card text-left py-2 pr-3 border-b border-border shadow-[0_1px_0_hsl(var(--border))]">Score</th>
              <th className="sticky top-0 z-20 bg-card text-left py-2 border-b border-border shadow-[0_1px_0_hsl(var(--border))]">Rationale</th>
              <th className="sticky top-0 z-20 bg-card text-left py-2 pl-3 border-b border-border shadow-[0_1px_0_hsl(var(--border))]">Calibrate</th>
            </tr>
          </thead>
          <tbody>
            {pagedRows.map(({ row: r, rowIndex: i, match: m, candidateKey, calibration }) => {
              const name = candidateDisplayName(r, i);
              const conf = m.confidence;
              const confClass =
                conf === 2 || conf === 3
                  ? "bg-primary/20 text-primary"
                  : conf === 1
                    ? "bg-muted text-muted-foreground"
                    : conf === "N/A"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-muted text-muted-foreground";
              return (
                <Fragment key={i}>
                  <tr
                    key={`row-${i}`}
                    className={`border-b border-border/40 hover-elevate ${selectedRowIndex === i ? "bg-primary/10 outline outline-1 outline-primary/30" : ""}`}
                    data-testid={`result-row-${i}`}
                    onClick={() => setSelectedRowIndex(i)}
                  >
                    <td className="py-1.5 pr-3 font-mono text-muted-foreground">
                      {i + 1}
                    </td>
                    <td className="py-1.5 pr-3 w-[210px] max-w-[210px] truncate" title={name}>
                      <div className="flex items-center gap-1.5">
                        <span className="truncate">{name}</span>
                        {calibration && (
                          <Badge variant="outline" className="h-5 px-1 text-[10px]">
                            {calibration.isCorrect ? "checked" : "calibrated"}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="py-1.5 pr-3 w-[170px]" data-testid={`result-dept-${i}`}>
                      {m.department === "Needs human review" ? (
                        <span className="text-destructive flex items-center gap-1">
                          <AlertCircle className="h-3 w-3" /> Needs review
                        </span>
                      ) : m.department.startsWith("Not a Match") ? (
                        <span className="text-destructive flex items-center gap-1">
                          <XCircle className="h-3 w-3" /> No match
                        </span>
                      ) : m.department.startsWith("Unsure") ? (
                        <span className="text-muted-foreground">Unsure</span>
                      ) : (
                        <span>{m.department}</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span
                        className={`inline-flex h-5 min-w-5 items-center justify-center rounded px-1 font-mono text-[11px] font-semibold ${confClass}`}
                        data-testid={`result-confidence-${i}`}
                      >
                        {conf === 3 ? 2 : conf}
                      </span>
                    </td>
                    <td
                      className="py-1.5 w-[390px] max-w-[390px] truncate text-muted-foreground"
                      title={m.rationale}
                    >
                      {m.rationale}
                    </td>
                    <td className="py-1.5 pl-3 w-[250px]">
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={(event) => {
                            event.stopPropagation();
                            openReviewPanel(i, m);
                          }}
                          data-testid={`button-review-result-${i}`}
                        >
                          <Eye className="mr-1 h-3.5 w-3.5" /> Review
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={(event) => {
                            event.stopPropagation();
                            onSaveCalibration(i, true, m.department, "", "Marked correct by recruiter.");
                          }}
                          data-testid={`button-calibration-correct-${i}`}
                        >
                          <Check className="mr-1 h-3.5 w-3.5" /> Correct
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={(event) => {
                            event.stopPropagation();
                            openCalibration(i, m);
                          }}
                          data-testid={`button-calibration-fix-${i}`}
                        >
                          <SlidersHorizontal className="mr-1 h-3.5 w-3.5" /> Fix
                        </Button>
                      </div>
                    </td>
                  </tr>
                  {activeCalibrationRow === i && (
                    <tr key={`calibration-${i}`} className="bg-primary/5">
                      <td colSpan={6} className="p-3 border-b border-primary/20">
                        <div className="grid gap-3" data-testid={`calibration-form-${i}`}>
                          <div className="space-y-1">
                            <label className="text-[11px] font-mono text-muted-foreground">
                              Correct department
                            </label>
                            <Input
                              value={correctedDepartment}
                              onChange={(e) => setCorrectedDepartment(e.target.value)}
                              className="h-8 text-xs"
                              data-testid={`input-corrected-department-${i}`}
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[11px] font-mono text-muted-foreground">
                              Why should it be different?
                            </label>
                            <Textarea
                              value={feedbackReason}
                              onChange={(e) => setFeedbackReason(e.target.value)}
                              placeholder="Example: Strong Snowflake delivery background, but candidate is based in LATAM and should route to Data Engineering rather than Analytics."
                              className="min-h-[72px] text-xs"
                              data-testid={`textarea-calibration-reason-${i}`}
                            />
                          </div>
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setActiveCalibrationRow(null)}
                              data-testid={`button-cancel-calibration-${i}`}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => saveCorrection(i)}
                              disabled={!correctedDepartment.trim()}
                              data-testid={`button-save-calibration-${i}`}
                            >
                              Save calibration
                            </Button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {pagedRows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-muted-foreground">
                  No candidates match the current search/filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Sheet open={Boolean(reviewItem)} onOpenChange={(open) => !open && setReviewRowIndex(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl" data-testid="sheet-result-review">
          {reviewItem && (
            <div className="space-y-5">
              <SheetHeader>
                <SheetTitle>Review candidate match</SheetTitle>
                <SheetDescription>
                  Full rationale and candidate context for row {reviewItem.rowIndex + 1}.
                </SheetDescription>
              </SheetHeader>

              <div className="rounded-lg border border-border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold" data-testid="text-review-candidate-name">
                      {candidateDisplayName(reviewItem.row, reviewItem.rowIndex)}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Suggested department: <span className="font-medium text-foreground">{reviewItem.match.department}</span>
                    </div>
                  </div>
                  <span
                    className={`inline-flex h-7 min-w-7 items-center justify-center rounded px-2 font-mono text-xs font-semibold ${
                      reviewItem.match.confidence === 2 || reviewItem.match.confidence === 3
                        ? "bg-primary/20 text-primary"
                        : reviewItem.match.confidence === 1
                          ? "bg-muted text-muted-foreground"
                          : reviewItem.match.confidence === "N/A"
                            ? "bg-destructive/10 text-destructive"
                            : "bg-muted text-muted-foreground"
                    }`}
                    data-testid="text-review-confidence"
                  >
                    {reviewItem.match.confidence === 3 ? 2 : reviewItem.match.confidence}
                  </span>
                </div>
                {reviewItem.calibration && (
                  <Badge variant="outline" className="mt-3">
                    {reviewItem.calibration.isCorrect ? "Already marked correct" : "Already calibrated"}
                  </Badge>
                )}
              </div>

              <div className="space-y-2">
                <div className="text-xs font-mono uppercase tracking-wide text-muted-foreground">
                  Full reasoning
                </div>
                <div className="rounded-lg border border-border bg-background/70 p-3 text-sm leading-6 text-foreground" data-testid="text-review-rationale">
                  {reviewItem.match.rationale}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-mono uppercase tracking-wide text-muted-foreground">
                  Candidate profile fields
                </div>
                <div className="max-h-72 overflow-auto rounded-lg border border-border">
                  <table className="w-full text-xs">
                    <tbody>
                      {Object.entries(reviewItem.row)
                        .filter(([, value]) => String(value || "").trim())
                        .map(([key, value]) => (
                          <tr key={key} className="border-b border-border/60 last:border-0">
                            <td className="w-40 bg-muted/40 px-3 py-2 align-top font-mono text-[11px] text-muted-foreground">
                              {key}
                            </td>
                            <td className="px-3 py-2 align-top text-foreground">
                              {String(value)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="font-semibold text-foreground">Calibration</div>
                    <div className="text-xs text-muted-foreground">
                      Mark the match correct, or capture what it should have been.
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      onSaveCalibration(
                        reviewItem.rowIndex,
                        true,
                        reviewItem.match.department,
                        "",
                        "Marked correct by recruiter.",
                      )
                    }
                    data-testid="button-review-mark-correct"
                  >
                    <Check className="mr-1.5 h-3.5 w-3.5" /> Mark correct
                  </Button>
                </div>
                <div className="grid gap-3">
                  <div className="space-y-1">
                    <label className="text-[11px] font-mono text-muted-foreground">
                      Correct department
                    </label>
                    <Input
                      value={correctedDepartment}
                      onChange={(e) => setCorrectedDepartment(e.target.value)}
                      className="h-8 text-xs"
                      data-testid="input-review-corrected-department"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-mono text-muted-foreground">
                      Why should it be different?
                    </label>
                    <Textarea
                      value={feedbackReason}
                      onChange={(e) => setFeedbackReason(e.target.value)}
                      placeholder="Example: Recent work is analytics and dashboard delivery, so this should be Analytics rather than Data Engineering."
                      className="min-h-[88px] text-xs"
                      data-testid="textarea-review-calibration-reason"
                    />
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => saveCorrection(reviewItem.rowIndex)}
                      disabled={!correctedDepartment.trim()}
                      data-testid="button-review-save-calibration"
                    >
                      Save correction
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground font-mono" data-testid="text-results-range">
          Showing {startRow}-{endRow} of {filteredRows.length} filtered candidates
          {filteredRows.length !== totalRows ? ` (${totalRows} total)` : ""}.
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={safePage === 0}
            onClick={() => {
              setPage((current) => Math.max(0, current - 1));
              setActiveCalibrationRow(null);
            }}
            data-testid="button-results-prev-page"
          >
            Previous
          </Button>
          <span className="text-xs font-mono text-muted-foreground" data-testid="text-results-page">
            Page {safePage + 1} of {pageCount}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={safePage >= pageCount - 1}
            onClick={() => {
              setPage((current) => Math.min(pageCount - 1, current + 1));
              setActiveCalibrationRow(null);
            }}
            data-testid="button-results-next-page"
          >
            Next
          </Button>
        </div>
      </div>
    </>
  );
}
