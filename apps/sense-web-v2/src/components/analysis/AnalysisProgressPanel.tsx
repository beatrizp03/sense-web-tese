import { useEffect, useState } from "react"

interface ProgressState {
  percentage: number
  signalKind: string
  elapsedSeconds: number
  startTime: number | null
  isRunning: boolean
  errorMessage?: string
}

interface AnalysisProgressPanelProps {
  isVisible: boolean
  onCancel?: () => void
  onRetry?: () => void
  totalTime?: number
  resultPath?: string
}

export const AnalysisProgressPanel: React.FC<AnalysisProgressPanelProps> = ({
  isVisible,
  onCancel,
  onRetry,
  totalTime,
  resultPath,
}) => {
  const [progress, setProgress] = useState<ProgressState>({
    percentage: 0,
    signalKind: "preparing",
    elapsedSeconds: 0,
    startTime: null,
    isRunning: true,
  })

  useEffect(() => {
    if (!isVisible) return

    // When component mounts or isVisible changes, initialize startTime to now
    const now = Date.now()
    setProgress((prev) => ({
      ...prev,
      startTime: now,
      isRunning: true,
      percentage: 0,
      signalKind: "preparing",
      elapsedSeconds: 0,
    }))

    const handleProgress = (event: any) => {
      const { percentage, signalKind } = event.detail
      setProgress((prev) => ({
        ...prev,
        percentage,
        signalKind: signalKind || prev.signalKind,
        isRunning: true,
      }))
    }

    const handleAnalysisComplete = () => {
      setProgress((prev) => ({
        ...prev,
        percentage: 100,
        isRunning: false,
      }))
    }

    const handleAnalysisError = (event: any) => {
      setProgress((prev) => ({
        ...prev,
        isRunning: false,
        errorMessage: event.detail?.message || "Analysis failed",
      }))
    }

    window.addEventListener("analysis-progress", handleProgress)
    window.addEventListener("analysis-complete", handleAnalysisComplete)
    window.addEventListener("analysis-error", handleAnalysisError)

    return () => {
      window.removeEventListener("analysis-progress", handleProgress)
      window.removeEventListener("analysis-complete", handleAnalysisComplete)
      window.removeEventListener("analysis-error", handleAnalysisError)
    }
  }, [isVisible])

  useEffect(() => {
    if (!progress.startTime || !progress.isRunning) return

    const interval = setInterval(() => {
      const elapsedMs = Date.now() - progress.startTime
      const elapsedSeconds = Math.floor(elapsedMs / 1000)
      setProgress((prev) => ({
        ...prev,
        elapsedSeconds,
      }))
    }, 1000)

    return () => clearInterval(interval)
  }, [progress.startTime, progress.isRunning])

  if (!isVisible) return null

  const formatTime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60
    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`
    if (minutes > 0) return `${minutes}m ${secs}s`
    return `${secs}s`
  }

  const barWidth = `${Math.max(0, Math.min(100, progress.percentage))}%`

  if (progress.errorMessage) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="w-full max-w-md rounded-lg border border-error-accent/40 bg-background-accent/70 p-6 shadow-xl backdrop-blur-md">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-2xl">✗</span>
            <h2 className="text-xl font-semibold text-error">Analysis Failed</h2>
          </div>
          <p className="text-sm text-over-background-medium mb-6">{progress.errorMessage}</p>
          <div className="flex gap-3">
            {onRetry && (
              <button
                onClick={onRetry}
                className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/95"
              >
                Retry
              </button>
            )}
            <button
              onClick={onCancel}
              className="flex-1 rounded-lg border border-over-primary-highest bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/95"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (progress.percentage === 100) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="w-full max-w-md rounded-lg bg-background-accent-dark p-6 shadow-lg dark:bg-background-accent-light">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-2xl text-over-background-highest-dark dark:text-over-background-highest-light">✓</span>
            <h2 className="text-xl font-semibold text-over-background-highest-dark dark:text-over-background-highest-light">Analysis Complete</h2>
          </div>
          <p className="text-sm text-over-background-medium-dark dark:text-over-background-medium-light mb-6">
            Total time: <span className="font-medium">{formatTime(progress.elapsedSeconds)}</span>
          </p>
          <div className="flex gap-3">
            {resultPath && (
              <button
                onClick={() => {
                  if (window.electronAPI?.openExternalPath) {
                    window.electronAPI.openExternalPath(resultPath)
                  }
                }}
                className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/95"
              >
                Open Results
              </button>
            )}
            <button
              onClick={onCancel}
              className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/95"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-background-accent-dark p-6 shadow-lg dark:bg-background-accent-light">
        <h2 className="mb-4 text-lg font-semibold text-over-background-highest-dark dark:text-over-background-highest-light">Analysis in Progress</h2>

        <div className="mb-6 space-y-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-over-background-medium-dark dark:text-over-background-medium-light">Progress</span>
              <span className="font-medium text-over-background-highest-dark dark:text-over-background-highest-light">{progress.percentage}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-primary/20 border border-over-background-highest-dark dark:border-over-background-highest-light">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: barWidth }}
              />
            </div>
          </div>

          <div className="space-y-1 pt-2">
            <p className="flex items-center gap-2 text-xs uppercase tracking-wider text-over-background-highest-dark dark:text-over-background-highest-light">
              <span
                aria-hidden="true"
                className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse"
              />
              Analyzing
            </p>
            <div className="rounded-lg bg-over-background-low-dark px-3 py-2 dark:bg-over-background-low-light">
              <p className="text-sm font-medium text-over-background-highest-dark dark:text-over-background-highest-light">
                {progress.signalKind.toUpperCase()}
              </p>
            </div>
          </div>

          <div className="text-sm text-over-background-medium-dark dark:text-over-background-medium-light">
            Elapsed: <span className="font-medium tabular-nums">{formatTime(progress.elapsedSeconds)}</span>
          </div>
        </div>

        {onCancel && (
          <button
            onClick={onCancel}
            className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/95"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
