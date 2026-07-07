import { EVENTS, TYPE_CHECK } from "@bitwarden/common/autofill/constants";

import AutofillScript, {
  AutofillInsertActions,
  FillScript,
  FillScriptActionTypes,
} from "../models/autofill-script";
import { FormFieldElement } from "../types";
import {
  currentlyInSandboxedIframe,
  elementIsFillableFormField,
  elementIsInputElement,
  elementIsSelectElement,
  elementIsTextAreaElement,
} from "../utils";

import { DomElementVisibilityService } from "./abstractions/dom-element-visibility.service";
import { InsertAutofillContentService as InsertAutofillContentServiceInterface } from "./abstractions/insert-autofill-content.service";
import { CollectAutofillContentService } from "./collect-autofill-content.service";

class InsertAutofillContentService implements InsertAutofillContentServiceInterface {
  private readonly autofillInsertActions: AutofillInsertActions = {
    fill_by_opid: ({ opid, value }) => this.handleFillFieldByOpidAction(opid, value),
    click_on_opid: ({ opid }) => this.handleClickOnFieldByOpidAction(opid),
    focus_by_opid: ({ opid }) => this.handleFocusOnFieldByOpidAction(opid),
  };

  /**
   * InsertAutofillContentService constructor. Instantiates the
   * DomElementVisibilityService and CollectAutofillContentService classes.
   */
  constructor(
    private domElementVisibilityService: DomElementVisibilityService,
    private collectAutofillContentService: CollectAutofillContentService,
  ) {}

  /**
   * Handles autofill of the forms on the current page based on the
   * data within the passed fill script object.
   * @param {AutofillScript} fillScript
   * @returns {Promise<void>}
   * @public
   */
  async fillForm(fillScript: AutofillScript) {
    if (
      !fillScript.script?.length ||
      currentlyInSandboxedIframe() ||
      this.userCancelledInsecureUrlAutofill(fillScript.savedUrls) ||
      this.userCancelledUntrustedIframeAutofill(fillScript)
    ) {
      return;
    }

    for (let index = 0; index < fillScript.script.length; index++) {
      await this.runFillScriptAction(fillScript.script[index]);
    }
  }

  /**
   * Checks if the autofill is occurring on a page that can be considered secure. If the page is not secure,
   * the user is prompted to confirm that they want to autofill on the page.
   * @param {string[] | null} savedUrls
   * @returns {boolean}
   * @private
   */
  private userCancelledInsecureUrlAutofill(savedUrls?: string[] | null): boolean {
    if (
      !savedUrls?.some((url) => url.startsWith(`https://${globalThis.location.hostname}`)) ||
      globalThis.location.protocol !== "http:" ||
      !this.isPasswordFieldWithinDocument()
    ) {
      return false;
    }

    const confirmationWarning = [
      chrome.i18n.getMessage("insecurePageWarning"),
      chrome.i18n.getMessage("insecurePageWarningFillPrompt", [globalThis.location.hostname]),
    ].join("\n\n");

    return !globalThis.confirm(confirmationWarning);
  }

  /**
   * Checks if there is a password field within the current document. Includes
   * password fields that are present within the shadow DOM.
   * @returns {boolean}
   * @private
   */
  private isPasswordFieldWithinDocument(): boolean {
    return this.collectAutofillContentService.isPasswordFieldWithinDocument();
  }

  /**
   * Checking if the autofill is occurring within an untrusted iframe. If the page is within an untrusted iframe,
   * the user is prompted to confirm that they want to autofill on the page. If the user cancels the autofill,
   * the script will not continue.
   *
   * Note: confirm() is blocked by sandboxed iframes, but we don't want to fill sandboxed iframes anyway.
   * If this occurs, confirm() returns false without displaying the dialog box, and autofill will be aborted.
   * The browser may print a message to the console, but this is not a standard error that we can handle.
   * @param {AutofillScript} fillScript
   * @returns {boolean}
   * @private
   */
  private userCancelledUntrustedIframeAutofill(fillScript: AutofillScript): boolean {
    if (!fillScript.untrustedIframe) {
      return false;
    }

    const confirmationWarning = [
      chrome.i18n.getMessage("autofillIframeWarning"),
      chrome.i18n.getMessage("autofillIframeWarningTip", [globalThis.location.hostname]),
    ].join("\n\n");

    return !globalThis.confirm(confirmationWarning);
  }

  /**
   * Runs the autofill action based on the action type and the opid.
   * Each action is subsequently delayed by 20 milliseconds.
   * @param {FillScript} [action, opid, value]
   * @returns {Promise<void>}
   * @private
   */
  private runFillScriptAction = ([action, opid, value]: FillScript): Promise<void> => {
    if (!opid || !this.autofillInsertActions[action]) {
      return Promise.resolve();
    }

    const delayActionsInMilliseconds = 20;
    return new Promise((resolve) =>
      setTimeout(() => {
        if (action === FillScriptActionTypes.fill_by_opid && !!value?.length) {
          this.autofillInsertActions.fill_by_opid({ opid, value });
        } else if (action === FillScriptActionTypes.click_on_opid) {
          this.autofillInsertActions.click_on_opid({ opid });
        } else if (action === FillScriptActionTypes.focus_by_opid) {
          this.autofillInsertActions.focus_by_opid({ opid });
        }

        resolve();
      }, delayActionsInMilliseconds),
    );
  };

  /**
   * Queries the DOM for an element by opid and inserts the passed value into the element.
   * @param {string} opid
   * @param {string} value
   * @private
   */
  private handleFillFieldByOpidAction(opid: string, value: string) {
    const element = this.collectAutofillContentService.getAutofillFieldElementByOpid(opid);
    this.insertValueIntoField(element, value);
  }

  /**
   * Handles finding an element by opid and triggering a click event on the element.
   * @param {string} opid
   * @private
   */
  private handleClickOnFieldByOpidAction(opid: string) {
    const element = this.collectAutofillContentService.getAutofillFieldElementByOpid(opid);

    if (element) {
      this.triggerClickOnElement(element);
    }
  }

  /**
   * Handles finding an element by opid and triggering click and focus events on the element.
   * To ensure that we trigger a blur event correctly on a filled field, we first check if the
   * element is already focused. If it is, we blur the element before focusing on it again.
   *
   * @param {string} opid - The opid of the element to focus on.
   */
  private handleFocusOnFieldByOpidAction(opid: string) {
    const element = this.collectAutofillContentService.getAutofillFieldElementByOpid(opid);

    if (!element) {
      return;
    }

    if (document.activeElement === element) {
      element.blur();
    }

    this.simulateUserMouseClickAndFocusEventInteractions(element, true);
  }

  /**
   * Identifies the type of element passed and inserts the value into the element.
   * Will trigger simulated events on the element to ensure that the element is
   * properly updated.
   * @param {FormFieldElement | null} element
   * @param {string} value
   * @private
   */
  private insertValueIntoField(element: FormFieldElement | null, value: string) {
    if (!element || !value) {
      return;
    }

    const elementCanBeReadonly =
      elementIsInputElement(element) || elementIsTextAreaElement(element);
    const elementCanBeFilled = elementCanBeReadonly || elementIsSelectElement(element);
    const elementValue = (element as HTMLInputElement)?.value || element?.innerText || "";

    const elementAlreadyHasTheValue = !!(elementValue?.length && elementValue === value);

    if (
      elementAlreadyHasTheValue ||
      (elementCanBeReadonly && element.readOnly) ||
      (elementCanBeFilled && element.disabled)
    ) {
      return;
    }

    if (!elementIsFillableFormField(element)) {
      this.handleInsertValueAndTriggerSimulatedEvents(element, () => (element.innerText = value));
      return;
    }

    const isFillableCheckboxOrRadioElement =
      elementIsInputElement(element) &&
      new Set(["checkbox", "radio"]).has(element.type) &&
      new Set(["true", "y", "1", "yes", "✓"]).has(String(value).toLowerCase());
    if (isFillableCheckboxOrRadioElement) {
      this.handleInsertValueAndTriggerSimulatedEvents(element, () => (element.checked = true));
      return;
    }

    this.handleInsertValueAndTriggerSimulatedEvents(element, () => (element.value = value));
  }

  /**
   * Simulates pre- and post-insert events on the element meant to mimic user interactions
   * while inserting the autofill value into the element.
   *
   * Verwendet den nativen property-Setter um React/Vue/Angular Value-Tracker zu umgehen.
   * Ohne diesen Trick erkennen Frameworks die Wertänderung nicht und lösen keine
   * Change-Handler aus — ein Hauptgrund für fehlgeschlagene Auto-Submits.
   *
   * @param {FormFieldElement} element
   * @param {Function} valueChangeCallback
   * @private
   */
  private handleInsertValueAndTriggerSimulatedEvents(
    element: FormFieldElement,
    valueChangeCallback: CallableFunction,
  ): void {
    this.triggerPreInsertEventsOnElement(element);
    this.setValueWithNativeSetter(element, valueChangeCallback);
    this.triggerPostInsertEventsOnElement(element);
    this.triggerFillAnimationOnElement(element);
  }

  /**
   * Setzt den Wert über den nativen Property-Setter des HTMLInputElement-Prototypen.
   * React, Vue und Angular überschreiben element.value mit eigenen Settern die
   * interne State-Tracker aktualisieren. Wenn wir direkt element.value setzen,
   * wird nur der DOM-Wert geändert, aber der Framework-interne Wert bleibt leer.
   *
   * Durch Aufruf des nativen Setters UND anschließendes Reset des React _valueTracker
   * erkennen alle Frameworks die Wertänderung korrekt.
   */
  private setValueWithNativeSetter(
    element: FormFieldElement,
    fallbackSetter: CallableFunction,
  ): void {
    if (!("value" in element)) {
      fallbackSetter();
      return;
    }

    // Nativen Setter vom HTMLInputElement/HTMLTextAreaElement-Prototypen holen
    const prototype = elementIsInputElement(element)
      ? HTMLInputElement.prototype
      : elementIsTextAreaElement(element)
        ? HTMLTextAreaElement.prototype
        : null;

    const nativeValueSetter = prototype
      ? Object.getOwnPropertyDescriptor(prototype, "value")?.set
      : null;

    if (nativeValueSetter) {
      // Zuerst den Wert über den nativen Setter setzen — umgeht Framework-Wrapper
      // (React, Vue, Angular überschreiben element.value mit eigenen Settern)
      const currentValue = element.value;
      fallbackSetter();
      const newValue = element.value;
      // Nochmals via nativen Setter setzen, damit der DOM-Wert sicher korrekt ist
      nativeValueSetter.call(element, newValue || currentValue);
      // React _valueTracker zurücksetzen damit onChange korrekt feuert
      this.resetReactValueTracker(element);
    } else {
      fallbackSetter();
    }
  }

  /**
   * Setzt Reacts internen _valueTracker zurück. React vergleicht den Tracker-Wert
   * mit dem aktuellen DOM-Wert — bei Gleichheit wird onChange unterdrückt.
   * Durch setValue('') erzwingen wir eine Differenz, sodass React onChange auslöst.
   */
  private resetReactValueTracker(element: FormFieldElement): void {
    const tracker = (element as any)?._valueTracker;
    if (tracker) {
      tracker.setValue("");
    }
  }

  /**
   * Simulates a mouse click event on the element, including focusing the event, and
   * the triggers a simulated keyboard event on the element. Will attempt to ensure
   * that the initial element value is not arbitrarily changed by the simulated events.
   * @param {FormFieldElement} element
   * @private
   */
  private triggerPreInsertEventsOnElement(element: FormFieldElement): void {
    const initialElementValue = "value" in element ? element.value : "";

    this.simulateUserMouseClickAndFocusEventInteractions(element);
    this.simulateUserKeyboardEventInteractions(element);

    if ("value" in element && initialElementValue !== element.value) {
      element.value = initialElementValue;
    }
  }

  /**
   * Simulates a keyboard event on the element before assigning the autofilled value to the element, and then
   * simulates an input change event on the element to trigger expected events after autofill occurs.
   * @param {FormFieldElement} element
   * @private
   */
  private triggerPostInsertEventsOnElement(element: FormFieldElement): void {
    const autofilledValue = "value" in element ? element.value : "";
    this.simulateUserKeyboardEventInteractions(element);

    if ("value" in element && autofilledValue !== element.value) {
      element.value = autofilledValue;
    }

    this.simulateInputElementChangedEvent(element);
  }

  /**
   * Identifies if a passed element can be animated and sets a class on the element
   * to trigger a CSS animation. The animation is removed after a short delay.
   * @param {FormFieldElement} element
   * @private
   */
  private triggerFillAnimationOnElement(element: FormFieldElement): void {
    const skipAnimatingElement =
      elementIsFillableFormField(element) &&
      !new Set(["email", "text", "password", "number", "tel", "url"]).has(element?.type);

    if (this.domElementVisibilityService.isElementHiddenByCss(element) || skipAnimatingElement) {
      return;
    }

    element.classList.add("com-bitwarden-browser-animated-fill");
    setTimeout(() => element.classList.remove("com-bitwarden-browser-animated-fill"), 200);
  }

  /**
   * Simulates a click  event on the element.
   * @param {HTMLElement} element
   * @private
   */
  private triggerClickOnElement(element?: HTMLElement): void {
    if (!element || typeof element.click !== TYPE_CHECK.FUNCTION) {
      return;
    }

    element.click();
  }

  /**
   * Simulates a focus event on the element. Will optionally reset the value of the element
   * if the element has a value property.
   * @param {HTMLElement | undefined} element
   * @param {boolean} shouldResetValue
   * @private
   */
  private triggerFocusOnElement(element: HTMLElement | undefined, shouldResetValue = false): void {
    if (!element || typeof element.focus !== TYPE_CHECK.FUNCTION) {
      return;
    }

    let initialValue = "";
    if (shouldResetValue && "value" in element) {
      initialValue = String(element.value);
    }

    element.focus();

    if (initialValue && "value" in element) {
      element.value = initialValue;
    }
  }

  /**
   * Simulates a mouse click and focus event on the element.
   * @param {FormFieldElement} element
   * @param {boolean} shouldResetValue
   * @private
   */
  private simulateUserMouseClickAndFocusEventInteractions(
    element: FormFieldElement,
    shouldResetValue = false,
  ): void {
    this.triggerClickOnElement(element);
    this.triggerFocusOnElement(element, shouldResetValue);
  }

  /**
   * Simulates keyboard events on the element, mocking a user interaction.
   * Enthält keydown, keypress und keyup mit realistischen Key-Properties,
   * damit Event-Handler die Events nicht als synthetisch verwerfen.
   * @param {FormFieldElement} element
   * @private
   */
  private simulateUserKeyboardEventInteractions(element: FormFieldElement): void {
    const keyEventInit: KeyboardEventInit = {
      bubbles: true,
      cancelable: true,
      key: "Unidentified",
      code: "",
    };
    element.dispatchEvent(new KeyboardEvent(EVENTS.KEYDOWN, keyEventInit));
    element.dispatchEvent(new KeyboardEvent(EVENTS.KEYUP, keyEventInit));
  }

  /**
   * Simulates input and change events on the element, mocking behavior that would occur if a user
   * manually changed a value for the element.
   *
   * Verwendet InputEvent statt generischem Event für das "input"-Event.
   * Das ist entscheidend für Framework-Kompatibilität:
   * - React hört auf InputEvent für kontrollierte Komponenten
   * - Vue v-model bindet an input-Events
   * - Angular ngModel reagiert auf input vor change
   *
   * @param {FormFieldElement} element
   * @private
   */
  private simulateInputElementChangedEvent(element: FormFieldElement): void {
    // InputEvent mit korrektem inputType — realistischer als generisches Event
    element.dispatchEvent(
      new InputEvent(EVENTS.INPUT, {
        bubbles: true,
        cancelable: false,
        inputType: "insertText",
        data: "value" in element ? String(element.value).slice(-1) || null : null,
      }),
    );
    element.dispatchEvent(new Event(EVENTS.CHANGE, { bubbles: true }));
  }
}

export default InsertAutofillContentService;
