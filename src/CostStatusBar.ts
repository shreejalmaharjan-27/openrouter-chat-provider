import vscode from 'vscode';
import { SessionTracker } from './SessionTracker';
import { SessionSummary } from './types';

export class CostStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly tracker: SessionTracker) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'orcp.showSessionDetails';
    this.render(this.tracker.summary);
    this.item.show();
    this.subscription = this.tracker.onDidChange.event((s) => this.render(s));
  }

  private render(s: SessionSummary): void {
    this.item.text = `$(zap) $${s.totalCostUSD.toFixed(4)} · ${s.turns} turn${s.turns === 1 ? '' : 's'}`;
    this.item.tooltip = `ORCP session — click for details`;
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
