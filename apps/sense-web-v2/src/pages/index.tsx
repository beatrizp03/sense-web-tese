import Link from "next/link"

import { TextButton } from "@scientisst/react-ui/components/inputs"

import ScientISSTSenseLogo from "../assets/logos/ScientISSTSenseLogo"
import ScientISSTSenseVerticalLogo from "../assets/logos/ScientISSTSenseVerticalLogo"
import SenseLayout from "../components/layout/SenseLayout"

const Page = () => {
	return (
		<SenseLayout
			title="Welcome!"
			className="flex w-[480px] flex-col items-center justify-center gap-8 py-8 px-8 sm:w-[640px]"
		>
			<ScientISSTSenseLogo className="hidden h-auto w-full sm:block" />
			<ScientISSTSenseVerticalLogo className="sm:hidden" />
			<div className="flex flex-col gap-8 self-stretch sm:flex-row">
				<Link href="/live" legacyBehavior>
					<TextButton size="lg" className="flex-grow">
						Live
					</TextButton>
				</Link>
				<Link href="/analysis" legacyBehavior>
					<TextButton size="lg" className="flex-grow">
						Analysis
					</TextButton>
				</Link>
				<Link href="/settings" legacyBehavior>
					<TextButton size="lg" className="flex-grow">
						Settings
					</TextButton>
				</Link>
			</div>
		</SenseLayout>
	)
}

export default Page
