import { EVENTS } from "@bitwarden/common/autofill/constants";

import AutofillPageDetails from "../models/autofill-page-details";
import { AutofillInlineMenuContentService } from "../overlay/inline-menu/abstractions/autofill-inline-menu-content.service";
import { OverlayNotificationsContentService } from "../overlay/notifications/abstractions/overlay-notifications-content.service";
import { AutofillOverlayContentService } from "../services/abstractions/autofill-overlay-content.service";
import { DomElementVisibilityService } from "../services/abstractions/dom-element-visibility.service";
import { DomQueryService } from "../services/abstractions/dom-query.service";
import { SubmitLoginButtonNames } from "../services/autofill-constants";
import { CollectAutofillContentService } from "../services/collect-autofill-content.service";
import InsertAutofillContentService from "../services/insert-autofill-content.service";
import { sendExtensionMessage } from "../utils";

import {
  AutofillExtensionMessage,
  AutofillExtensionMessageHandlers,
  AutofillInit as AutofillInitInterface,
} from "./abstractions/autofill-init";

class AutofillInit implements AutofillInitInterface {
  private readonly sendExtensionMessage = sendExtensionMessage;
  private readonly collectAutofillContentService: CollectAutofillContentService;
  private readonly insertAutofillContentService: InsertAutofillContentService;
  private collectPageDetailsOnLoadTimeout: number | NodeJS.Timeout | undefined;
  private lastFilledElement: HTMLElement | null = null;
  private readonly extensionMessageHandlers: AutofillExtensionMessageHandlers = {
    collectPageDetails: ({ message }) => this.collectPageDetails(message),
    collectPageDetailsImmediately: ({ message }) => this.collectPageDetails(message, true),
    fillForm: ({ message }) => this.fillForm(message),
  };

  /**
   * AutofillInit constructor. Initializes the DomElementVisibilityService,
   * CollectAutofillContentService and InsertAutofillContentService classes.
   *
   * @param domQueryService - Service used to handle DOM queries.
   * @param domElementVisibilityService - Used to check if an element is viewable.
   * @param autofillOverlayContentService - The autofill overlay content service, potentially undefined.
   * @param autofillInlineMenuContentService - The inline menu content service, potentially undefined.
   * @param overlayNotificationsContentService - The overlay notifications content service, potentially undefined.
   */
  constructor(
    domQueryService: DomQueryService,
    domElementVisibilityService: DomElementVisibilityService,
    private autofillOverlayContentService?: AutofillOverlayContentService,
    private autofillInlineMenuContentService?: AutofillInlineMenuContentService,
    private overlayNotificationsContentService?: OverlayNotificationsContentService,
  ) {
    this.collectAutofillContentService = new CollectAutofillContentService(
      domElementVisibilityService,
      domQueryService,
      this.autofillOverlayContentService,
    );
    this.insertAutofillContentService = new InsertAutofillContentService(
      domElementVisibilityService,
      this.collectAutofillContentService,
    );
  }

  /**
   * Initializes the autofill content script, setting up
   * the extension message listeners. This method should
   * be called once when the content script is loaded.
   */
  init() {
    this.setupExtensionMessageListeners();
    this.autofillOverlayContentService?.init();
    this.collectPageDetailsOnLoad();
  }

  /**
   * Triggers a collection of the page details from the
   * background script, ensuring that autofill is ready
   * to act on the page.
   */
  private collectPageDetailsOnLoad() {
    if (globalThis.document.readyState === "complete") {
      this.sendCollectDetailsMessage();
    }

    globalThis.addEventListener(EVENTS.LOAD, this.sendCollectDetailsMessage);
  }

  /**
   * Sends a message to collect page details after a short delay.
   */
  private sendCollectDetailsMessage = () => {
    this.clearCollectPageDetailsOnLoadTimeout();
    this.collectPageDetailsOnLoadTimeout = setTimeout(
      () => this.sendExtensionMessage("bgCollectPageDetails", { sender: "autofillInit" }),
      750,
    );
  };

  /**
   * Collects the page details and sends them to the
   * extension background script. If the `sendDetailsInResponse`
   * parameter is set to true, the page details will be
   * returned to facilitate sending the details in the
   * response to the extension message.
   *
   * @param message - The extension message.
   * @param sendDetailsInResponse - Determines whether to send the details in the response.
   */
  private async collectPageDetails(
    message: AutofillExtensionMessage,
    sendDetailsInResponse = false,
  ): Promise<AutofillPageDetails | void> {
    const pageDetails: AutofillPageDetails =
      await this.collectAutofillContentService.getPageDetails();
    if (sendDetailsInResponse) {
      return pageDetails;
    }

    void this.sendExtensionMessage("collectPageDetailsResponse", {
      tab: message.tab,
      details: pageDetails,
      sender: message.sender,
    });
  }

  /**
   * Fills the form with the given fill script.
   *
   * @param {AutofillExtensionMessage} message
   */
  private async fillForm({
    fillScript,
    pageDetailsUrl,
    autoSubmitAfterFill,
  }: AutofillExtensionMessage) {
    if ((document.defaultView || window).location.href !== pageDetailsUrl || !fillScript) {
      return;
    }

    this.blurFocusedFieldAndCloseInlineMenu();
    await this.sendExtensionMessage("updateIsFieldCurrentlyFilling", {
      isFieldCurrentlyFilling: true,
    });
    await this.insertAutofillContentService.fillForm(fillScript);

    // Sofort nach dem Fill das aktive Element merken (bevor Animation-Klasse entfernt wird)
    this.lastFilledElement = document.activeElement as HTMLElement;

    setTimeout(
      () =>
        this.sendExtensionMessage("updateIsFieldCurrentlyFilling", {
          isFieldCurrentlyFilling: false,
        }),
      250,
    );

    // Nach dem Füllen automatisch absenden, wenn aktiviert
    if (autoSubmitAfterFill) {
      setTimeout(() => this.trySubmitForm(), 500);
    }
  }

  /**
   * Versucht das Formular abzusenden. Sucht aggressiv nach dem Submit-Button:
   * 1. type="submit" Buttons/Inputs
   * 2. Alle klickbaren Elemente mit Submit-Keywords im Text/Attributen
   * 3. Einziger sichtbarer Button auf der Seite → klicken
   * 4. form.requestSubmit() als Fallback
   */
  private trySubmitForm() {
    // Referenz auf das zuletzt gefüllte Element nutzen
    const filledEl = this.lastFilledElement;
    const form = filledEl?.closest("form") as HTMLFormElement;

    // Breiter Selektor für alle klickbaren Elemente
    const clickableSelector =
      "button, input[type='submit'], input[type='button'], " +
      "[role='button'], a.btn, a[class*='button'], a[class*='btn'], " +
      "a[class*='submit'], a[class*='login'], span[class*='btn'], " +
      "div[class*='btn'], span[onclick], div[onclick]";

    // 1. Expliziten type="submit" suchen
    const submitBtn = document.querySelector<HTMLElement>(
      "input[type='submit'], button[type='submit']",
    );
    if (submitBtn && this.isElementVisible(submitBtn)) {
      submitBtn.click();
      return;
    }

    // 2. Alle klickbaren Elemente mit Submit-Keywords durchsuchen
    const allClickables = document.querySelectorAll<HTMLElement>(clickableSelector);
    for (const el of Array.from(allClickables)) {
      if (this.isSubmitElement(el) && this.isElementVisible(el)) {
        el.click();
        return;
      }
    }

    // 3. Einziger sichtbarer Button auf der Seite → wahrscheinlich der Submit
    const visibleButtons = Array.from(allClickables).filter(
      (el) => this.isElementVisible(el) && !this.isResetOrCancelButton(el),
    );
    if (visibleButtons.length === 1) {
      visibleButtons[0].click();
      return;
    }

    // 4. Bei mehreren Buttons: den nächsten zum gefüllten Feld wählen
    if (filledEl && visibleButtons.length > 1) {
      const closest = this.findClosestElement(filledEl, visibleButtons);
      if (closest) {
        closest.click();
        return;
      }
    }

    // 5. form.requestSubmit() als Fallback
    if (form) {
      if (form.requestSubmit) {
        form.requestSubmit();
      } else {
        form.submit();
      }
    }
  }

  /**
   * Prüft ob ein Element ein Submit-/Login-Button ist.
   */
  private isSubmitElement(element: HTMLElement): boolean {
    const searchText = this.getElementSearchText(element);
    return SubmitLoginButtonNames.some((keyword) => searchText.includes(keyword));
  }

  /**
   * Prüft ob ein Element ein Cancel/Reset-Button ist (soll nicht geklickt werden).
   */
  private isResetOrCancelButton(element: HTMLElement): boolean {
    const searchText = this.getElementSearchText(element);
    const cancelKeywords = [
      "cancel",
      "reset",
      "abbrechen",
      "zurück",
      "back",
      "close",
      "schließen",
      "clear",
    ];
    return cancelKeywords.some((kw) => searchText.includes(kw));
  }

  /**
   * Sammelt durchsuchbaren Text eines Elements (Text, Attribute, Labels).
   */
  private getElementSearchText(element: HTMLElement): string {
    return [
      element.textContent?.trim(),
      element.getAttribute("value"),
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("id"),
      element.getAttribute("name"),
      element.getAttribute("class"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .replace(/[-_\s]+/g, "");
  }

  /**
   * Findet das Element aus der Liste das dem Referenz-Element am nächsten ist (DOM-Distanz).
   */
  private findClosestElement(
    reference: HTMLElement,
    candidates: HTMLElement[],
  ): HTMLElement | null {
    if (!candidates.length) {
      return null;
    }

    const refRect = reference.getBoundingClientRect();
    let closest: HTMLElement | null = null;
    let minDistance = Infinity;

    for (const candidate of candidates) {
      // Cancel/Reset-Buttons überspringen
      if (this.isResetOrCancelButton(candidate)) {
        continue;
      }
      const rect = candidate.getBoundingClientRect();
      const distance = Math.sqrt(
        Math.pow(rect.left - refRect.left, 2) + Math.pow(rect.top - refRect.top, 2),
      );
      if (distance < minDistance) {
        minDistance = distance;
        closest = candidate;
      }
    }
    return closest;
  }

  /**
   * Prüft ob ein Element sichtbar ist.
   */
  private isElementVisible(element: HTMLElement): boolean {
    if (!element) {
      return false;
    }
    return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  }

  /**
   * Blurs the most recently focused field and removes the inline menu. Used
   * in cases where the background unlock or vault item reprompt popout
   * is opened.
   */
  private blurFocusedFieldAndCloseInlineMenu() {
    this.autofillOverlayContentService?.blurMostRecentlyFocusedField(true);
  }

  /**
   * Clears the send collect details message timeout.
   */
  private clearCollectPageDetailsOnLoadTimeout() {
    if (this.collectPageDetailsOnLoadTimeout) {
      clearTimeout(this.collectPageDetailsOnLoadTimeout);
    }
  }

  /**
   * Sets up the extension message listeners for the content script.
   */
  private setupExtensionMessageListeners() {
    chrome.runtime.onMessage.addListener(this.handleExtensionMessage);
  }

  /**
   * Handles the extension messages sent to the content script.
   *
   * @param message - The extension message.
   * @param sender - The message sender.
   * @param sendResponse - The send response callback.
   */
  private handleExtensionMessage = (
    message: AutofillExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void,
  ): boolean | null => {
    const command: string = message.command;
    const handler: CallableFunction | undefined = this.getExtensionMessageHandler(command);
    if (!handler) {
      return null;
    }

    const messageResponse = handler({ message, sender });
    if (typeof messageResponse === "undefined") {
      return null;
    }

    void Promise.resolve(messageResponse).then((response) => sendResponse(response));
    return true;
  };

  /**
   * Gets the extension message handler for the given command.
   *
   * @param command - The extension message command.
   */
  private getExtensionMessageHandler(command: string): CallableFunction | undefined {
    if (this.autofillOverlayContentService?.messageHandlers?.[command]) {
      return this.autofillOverlayContentService.messageHandlers[command];
    }

    if (this.autofillInlineMenuContentService?.messageHandlers?.[command]) {
      return this.autofillInlineMenuContentService.messageHandlers[command];
    }

    if (this.overlayNotificationsContentService?.messageHandlers?.[command]) {
      return this.overlayNotificationsContentService.messageHandlers[command];
    }

    return this.extensionMessageHandlers[command];
  }

  /**
   * Handles destroying the autofill init content script. Removes all
   * listeners, timeouts, and object instances to prevent memory leaks.
   */
  destroy() {
    this.clearCollectPageDetailsOnLoadTimeout();
    globalThis.removeEventListener(EVENTS.LOAD, this.sendCollectDetailsMessage);
    chrome.runtime.onMessage.removeListener(this.handleExtensionMessage);
    this.collectAutofillContentService.destroy();
    this.autofillOverlayContentService?.destroy();
    this.autofillInlineMenuContentService?.destroy();
    this.overlayNotificationsContentService?.destroy();
  }
}

export default AutofillInit;
