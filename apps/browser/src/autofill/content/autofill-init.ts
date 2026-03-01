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

    // Gefülltes Element merken — activeElement ist nach dem Fill idealerweise das letzte Feld.
    // Falls activeElement body ist (z.B. nach Blur), Fallback über gefüllte Passwort-Felder.
    const activeEl = document.activeElement as HTMLElement;
    if (activeEl && activeEl !== document.body) {
      this.lastFilledElement = activeEl;
    } else {
      // Fallback: letztes sichtbares Passwort- oder Text-Input mit Wert finden
      const filledInputs = document.querySelectorAll<HTMLInputElement>(
        "input[type='password'], input[type='text'], input[type='email']",
      );
      const lastFilled = Array.from(filledInputs)
        .reverse()
        .find((el) => el.value && this.isElementVisible(el));
      this.lastFilledElement = lastFilled || activeEl;
    }

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
   * Versucht das Formular abzusenden.
   *
   * Strategie (Reihenfolge) — Button-Klick zuerst, requestSubmit als Fallback:
   * 1. Submit-Button im Formular suchen und klicken (zuverlässigste Methode)
   * 2. Globaler Submit-Button (falls Formular-Suche fehlschlägt)
   * 3. Klickbare Elemente mit Submit-Keywords (Text, Attribute, ARIA)
   * 4. cursor:pointer Elemente nahe dem gefüllten Feld (für ExtJS etc.)
   * 5. form.requestSubmit() — für Fälle wo der Button disabled ist aber
   *    das Framework den Submit-Event handelt (Vue @submit.prevent etc.)
   * 6. Einziger sichtbarer nicht-Cancel-Button als Notfall
   * 7. form.submit() als absolut letzter Fallback
   */
  private trySubmitForm() {
    const filledEl = this.lastFilledElement;
    const form = filledEl?.closest("form") as HTMLFormElement;

    // Selektor für klickbare Elemente (breit: Standard + Frameworks wie ExtJS)
    const clickableSelector =
      "button:not([disabled]), input[type='submit']:not([disabled]), " +
      "input[type='button']:not([disabled]), [role='button'], " +
      "a.btn, a[class*='button'], a[class*='btn'], " +
      "span[class*='btn'], div[class*='btn']";

    // 1. Submit-Button innerhalb des Formulars suchen und klicken
    if (form) {
      const formSubmitBtn = form.querySelector<HTMLElement>(
        "button[type='submit']:not([disabled]), input[type='submit']:not([disabled])",
      );
      if (formSubmitBtn && this.isElementVisible(formSubmitBtn)) {
        this.simulateFullClick(formSubmitBtn);
        return;
      }

      // Auch Buttons ohne expliziten type (default ist submit in einem <form>)
      const defaultBtn = form.querySelector<HTMLButtonElement>(
        "button:not([type]):not([disabled])",
      );
      if (
        defaultBtn &&
        this.isElementVisible(defaultBtn) &&
        !this.isResetOrCancelButton(defaultBtn)
      ) {
        this.simulateFullClick(defaultBtn);
        return;
      }
    }

    // 2. Globaler Submit-Button (außerhalb des Formulars oder kein Formular gefunden)
    const globalSubmitBtn = document.querySelector<HTMLElement>(
      "button[type='submit']:not([disabled]), input[type='submit']:not([disabled])",
    );
    if (globalSubmitBtn && this.isElementVisible(globalSubmitBtn)) {
      this.simulateFullClick(globalSubmitBtn);
      return;
    }

    // 3. Klickbare Elemente mit Submit-Keywords (Text, ARIA-Label, Klassen etc.)
    const allClickables = document.querySelectorAll<HTMLElement>(clickableSelector);
    for (const el of Array.from(allClickables)) {
      if (this.isSubmitElement(el) && this.isElementVisible(el)) {
        this.simulateFullClick(el);
        return;
      }
    }

    // 4. cursor:pointer Elemente nahe dem gefüllten Feld (ExtJS, Custom UIs)
    if (filledEl) {
      const pointerEl = this.findNearestPointerElement(filledEl);
      if (pointerEl) {
        this.simulateFullClick(pointerEl);
        return;
      }
    }

    // 5. form.requestSubmit() — für Frameworks die den Submit-Event handeln
    //    auch wenn der Button noch disabled ist (z.B. Vue :disabled Binding)
    if (form) {
      try {
        form.requestSubmit();
        return;
      } catch {
        // requestSubmit schlägt fehl wenn Submit-Button disabled ist
        // Dann manuell den Submit-Event dispatchen
        try {
          form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          return;
        } catch {
          // Weiter zu Notfall-Strategien
        }
      }
    }

    // 6. Einziger sichtbarer nicht-Cancel-Button als Notfall
    const visibleButtons = Array.from(allClickables).filter(
      (el) => this.isElementVisible(el) && !this.isResetOrCancelButton(el),
    );
    if (visibleButtons.length === 1) {
      this.simulateFullClick(visibleButtons[0]);
      return;
    }

    // 7. Letzter Fallback: form.submit() (ohne Events, direkte Submission)
    if (form) {
      form.submit();
    }
  }

  /**
   * Simuliert einen vollständigen Mausklick (mousedown → mouseup → click).
   * Manche Frameworks reagieren nur auf die vollständige Event-Sequenz.
   */
  private simulateFullClick(element: HTMLElement) {
    const eventInit: MouseEventInit = { bubbles: true, cancelable: true, view: window };
    element.dispatchEvent(new MouseEvent("mousedown", eventInit));
    element.dispatchEvent(new MouseEvent("mouseup", eventInit));
    element.click();
  }

  /**
   * Prüft ob ein Element ein Submit-/Login-Button ist.
   */
  private isSubmitElement(element: HTMLElement): boolean {
    const searchText = this.getElementSearchText(element);
    return SubmitLoginButtonNames.some((keyword) => searchText.includes(keyword));
  }

  /**
   * Prüft ob ein Element ein Cancel/Reset-Button ist.
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
      "dismiss",
    ];
    return cancelKeywords.some((kw) => searchText.includes(kw));
  }

  /**
   * Sammelt durchsuchbaren Text eines Elements.
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
   * Findet das nächste klickbare Element (cursor:pointer) in der Nähe des
   * Referenz-Elements. Für Frameworks wie ExtJS die keine Standard-Buttons nutzen.
   */
  private findNearestPointerElement(reference: HTMLElement): HTMLElement | null {
    const refRect = reference.getBoundingClientRect();
    let closest: HTMLElement | null = null;
    let minDistance = Infinity;

    // Alle sichtbaren Elemente mit cursor:pointer finden
    const candidates = document.querySelectorAll<HTMLElement>("*");
    for (const el of Array.from(candidates)) {
      // Nur Elemente die wie Buttons aussehen
      if (el.contains(reference) || el === reference) {
        continue;
      }
      if (el.querySelector("input, select, textarea")) {
        continue;
      }

      const style = globalThis.getComputedStyle(el);
      if (style.cursor !== "pointer") {
        continue;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20 || rect.width > 500) {
        continue;
      }
      if (!this.isElementVisible(el)) {
        continue;
      }
      if (this.isResetOrCancelButton(el)) {
        continue;
      }

      // Nur Elemente die Submit-Keywords haben ODER der einzige Button-ähnliche Kandidat sind
      const hasKeyword = this.isSubmitElement(el);
      const text = el.textContent?.trim();
      if (!hasKeyword && (!text || text.length > 30)) {
        continue;
      }

      const distance = Math.sqrt(
        Math.pow(rect.left - refRect.left, 2) + Math.pow(rect.top - refRect.top, 2),
      );
      // Bonus für Elemente mit Submit-Keywords
      const adjustedDistance = hasKeyword ? distance * 0.3 : distance;
      if (adjustedDistance < minDistance) {
        minDistance = adjustedDistance;
        closest = el;
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
