declare module "mammoth/mammoth.browser" {
  export interface ConvertToHtmlOptions {
    arrayBuffer: ArrayBuffer;
  }
  export interface ConvertToHtmlResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  export function convertToHtml(options: ConvertToHtmlOptions): Promise<ConvertToHtmlResult>;
}
