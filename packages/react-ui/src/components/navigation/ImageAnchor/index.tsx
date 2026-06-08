import Link from "next/link"

import clsx from "clsx"

export interface ImageAnchorProps {
	children?: React.ReactNode
	href: React.ComponentPropsWithoutRef<typeof Link>["href"]
	className?: string
	style?: React.CSSProperties
	ariaLabel?: string
	target?: "_blank" | string
	rel?: string
}

const ImageAnchor: React.FC<ImageAnchorProps> = ({
	children,
	href,
	className,
	style,
	ariaLabel,
	target,
	rel,
	...props
}) => {
	const sharedClassName = clsx(
		"flex items-center justify-center leading-none motion-safe:hover:scale-hover motion-safe:active:scale-pressed",
		className
	)

	if (target === "_blank") {
		return (
			<a
				href={typeof href === "string" ? href : ""}
				target={target}
				rel={rel ?? "noopener noreferrer"}
				className={sharedClassName}
				aria-label={ariaLabel}
				style={style}
				{...props}
			>
				{children}
			</a>
		)
	}

	return (
		<Link
			href={href}
			className={sharedClassName}
			aria-label={ariaLabel}
			style={style}
			{...props}
		>
			{children}
		</Link>
	)
}

export default ImageAnchor