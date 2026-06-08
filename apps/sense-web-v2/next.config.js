// @ts-check

/**
 * @type {import('next').NextConfig}
 **/
const nextConfig = {
	reactStrictMode: true,
	transpilePackages: [
		"@scientisst/sense",
		"@scientisst/chakra-ui",
		"esptool-js"
	],
	logging: {
		incomingRequests: false
	}
}

module.exports = nextConfig
