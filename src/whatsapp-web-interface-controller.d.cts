declare module '*/src/util/InterfaceController' {
  class InterfaceController {
    constructor(props: Pick<import('whatsapp-web.js').Client, 'pupPage'>);

    pupPage: import('whatsapp-web.js').Client['pupPage'];

    openChatWindow(chatId: string): Promise<unknown>;
    openChatDrawer(chatId: string): Promise<void>;
    openChatSearch(chatId: string): Promise<void>;
    openChatWindowAt(msgId: string): Promise<void>;
    openMessageDrawer(msgId: string): Promise<void>;
    closeRightDrawer(): Promise<void>;
    getFeatures(): Promise<unknown>;
    checkFeatureStatus(feature: string): Promise<unknown>;
    enableFeatures(features: string[]): Promise<void>;
    disableFeatures(features: string[]): Promise<void>;
  }

  export = InterfaceController;
}
