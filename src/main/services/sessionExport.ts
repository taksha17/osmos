/**
 * Session report export — Architecture v2, §15 / Phase 5 exit row
 * "session reports and exports available offline".
 *
 * The report itself is pure (`shared/policy/sessionReport.ts`); this only asks for
 * a destination and writes the markdown. The summary goes to the log because the
 * export used to exist as a tested function nothing could reach.
 */

import fs from 'node:fs';
import { dialog, type BrowserWindow } from 'electron';
import { buildSessionReport, renderReportMarkdown, reportFileName } from '../../shared/policy/sessionReport.js';
import type { ChatSession } from '../../shared/types.js';

export type ExportReportResult = {
  ok: boolean;
  path?: string;
  cancelled?: boolean;
  error?: string;
  /** Short human summary of what the file contains. */
  summary?: string;
};

export async function exportSessionReport(
  session: ChatSession,
  parent?: BrowserWindow,
): Promise<ExportReportResult> {
  try {
    const report = buildSessionReport(session);
    const markdown = renderReportMarkdown(report);
    const options = {
      title: 'Export session report',
      defaultPath: reportFileName(report),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    };
    const picked = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
    fs.writeFileSync(picked.filePath, markdown, 'utf-8');
    const { metrics } = report;
    console.log(
      `[sessionExport] wrote ${picked.filePath} (${metrics.questions} questions, ${metrics.unanswered} unanswered)`,
    );
    return {
      ok: true,
      path: picked.filePath,
      summary: `${metrics.questions} questions · ${metrics.answered} answered · ${metrics.unanswered} unanswered`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
