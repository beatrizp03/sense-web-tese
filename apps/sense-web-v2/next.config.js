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
	allowedDevOrigins: ["127.0.0.1", "localhost"],
	devIndicators: false,
	logging: {
		incomingRequests: false
	}
}

module.exports = nextConfig
