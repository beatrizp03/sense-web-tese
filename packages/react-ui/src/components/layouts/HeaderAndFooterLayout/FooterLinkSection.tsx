import clsx from "clsx"

export interface FooterLinkSectionProps {
	title: React.ReactNode
	links: Array<{
		href: string
		label: React.ReactNode
	}>
	className?: string
	style?: React.CSSProperties
}

const FooterLinkSection: React.FC<FooterLinkSectionProps> = ({
	title,
	links,
	className,
	style
}) => {
	return (
		<div
			className={clsx(
				"mt-[-0.75rem] flex flex-col items-start gap-2",
				className
			)}
			style={style}
		>
			<h4 className="mb-2 font-secondary text-2xl">{title}</h4>
			{links.map(({ href, label }, index) => (
				<a
					key={index}
					href={href}
					target="_blank"
					rel="noopener noreferrer"
					className="text-over-primary-highest motion-safe:hover:scale-hover motion-safe:active:scale-pressed"
				>
					{label}
				</a>
			))}
		</div>
	)
}

export default FooterLinkSection
