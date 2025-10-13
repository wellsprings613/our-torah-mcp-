declare module 'robots-parser' {
  interface Robots {
    isAllowed(url: string, userAgent?: string): boolean;
  }
  function robotsParser(robotsUrl: string, robotsTxt: string): Robots;
  export default robotsParser;
}
