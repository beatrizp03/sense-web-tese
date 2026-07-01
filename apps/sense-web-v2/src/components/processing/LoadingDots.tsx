export const LOADING_BUTTON_CLASS =
	"!opacity-95 motion-safe:animate-pulse " +
	"!bg-over-background-medium-light dark:!bg-over-background-medium-dark " +
	"!text-background-light dark:!text-background-dark"

const LoadingDots = ({ className = "" }: { className?: string }) => (
	<span className={`inline-flex items-center gap-1 opacity-75 ${className}`} aria-hidden>
		<span className="h-2 w-2 animate-pulse rounded-full bg-background-light dark:bg-background-dark [animation-delay:0ms]" />
		<span className="h-2 w-2 animate-pulse rounded-full bg-background-light dark:bg-background-dark [animation-delay:200ms]" />
		<span className="h-2 w-2 animate-pulse rounded-full bg-background-light dark:bg-background-dark [animation-delay:400ms]" />
	</span>
)

export default LoadingDots
