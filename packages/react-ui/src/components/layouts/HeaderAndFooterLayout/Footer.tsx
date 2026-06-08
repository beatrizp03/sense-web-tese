import { ReactNode } from "react"

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import clsx from "clsx"

import { ImageAnchor } from "../../navigation"
import FooterLinkSection, { FooterLinkSectionProps } from "./FooterLinkSection"

export interface SocialMediaLink {
	href: React.ComponentPropsWithoutRef<typeof ImageAnchor>["href"]
	icon: React.ComponentPropsWithoutRef<typeof FontAwesomeIcon>["icon"]
	ariaLabel: React.ComponentPropsWithoutRef<typeof ImageAnchor>["ariaLabel"]
}

export interface SponsorLink {
	href: React.ComponentPropsWithoutRef<typeof ImageAnchor>["href"]
	img: React.ComponentPropsWithoutRef<typeof ImageAnchor>["children"]
	ariaLabel?: React.ComponentPropsWithoutRef<typeof ImageAnchor>["ariaLabel"]
}

export interface FooterProps {
	socialMediaLinks?: SocialMediaLink[]
	logo?: ReactNode
	motto?: string
	sectionA?: FooterLinkSectionProps
	sectionB?: FooterLinkSectionProps
	sectionC?: FooterLinkSectionProps
	sponsorLinks?: SponsorLink[]
}

const Footer: React.FC<FooterProps> = ({
	socialMediaLinks,
	logo,
	motto,
	sectionA,
	sectionB,
	sectionC,
	sponsorLinks
}) => {
	return (
		<footer className="bg-primary text-over-primary-highest flex justify-center overflow-hidden drop-shadow-lg">
			<div className="container flex flex-col p-8">
				<div className="flex flex-col items-start justify-between gap-12 sm:flex-row sm:gap-8">
					<div className="flex max-w-[21rem] flex-col items-start gap-4">
						{logo}
						<p className="text-lg font-medium">{motto}</p>
						{!!socialMediaLinks && (
							<div className="m-[-0.5rem] flex">
								{socialMediaLinks.map(
									({ href, icon, ariaLabel }, index) => (
										<ImageAnchor
											key={index}
											href={href}
											ariaLabel={ariaLabel}
											target="_blank"
											rel="noopener noreferrer"
										>
											<FontAwesomeIcon
												icon={icon}
												className="h-8 w-8 p-2"
											/>
										</ImageAnchor>
									)
								)}
							</div>
						)}
					</div>
					{!!sectionA && (
						<FooterLinkSection
							{...sectionA}
							className={clsx(
								"flex sm:hidden xl:flex",
								sectionA.className
							)}
						/>
					)}
					{!!sectionB && (
						<FooterLinkSection
							{...sectionB}
							className={clsx(
								"flex sm:hidden xl:flex",
								sectionB.className
							)}
						/>
					)}
					{!!sectionC && (
						<FooterLinkSection
							{...sectionC}
							className={clsx(
								"flex sm:hidden xl:flex",
								sectionC.className
							)}
						/>
					)}
					{!!sponsorLinks && (
						<div className="flex flex-col items-start gap-4">
							{sponsorLinks.map(
								({ href, img, ariaLabel }, index) => (
									<ImageAnchor
										key={index}
										href={href}
										ariaLabel={ariaLabel}
										target="_blank"
										rel="noopener noreferrer"
									>
										{img}
									</ImageAnchor>
								)
							)}
						</div>
					)}
				</div>
				<div className="text-over-primary-highest my-8 hidden border-t opacity-50 sm:block xl:hidden" />
				<div className="hidden items-start justify-between gap-8 sm:flex xl:hidden">
					{!!sectionA && <FooterLinkSection {...sectionA} />}
					{!!sectionB && <FooterLinkSection {...sectionB} />}
					{!!sectionC && <FooterLinkSection {...sectionC} />}
				</div>
			</div>
		</footer>
	)
}

export default Footer
