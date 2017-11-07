import {
    createSavedQuestion,
    createTestStore, forBothAdminsAndNormalUsers, useSharedAdminLogin,
    useSharedNormalLogin
} from "__support__/integrated_tests";
import {
    click, clickButton
} from "__support__/enzyme_utils"

import { mount } from "enzyme";
import { AlertApi, CardApi, PulseApi } from "metabase/services";
import Question from "metabase-lib/lib/Question";
import * as Urls from "metabase/lib/urls";
import { INITIALIZE_QB, QUERY_COMPLETED } from "metabase/query_builder/actions";
import QueryHeader from "metabase/query_builder/components/QueryHeader";
import EntityMenu from "metabase/components/EntityMenu";
import { delay } from "metabase/lib/promise";
import Icon from "metabase/components/Icon";
import {
    AlertEducationalScreen,
    AlertSettingToggle,
    CreateAlertModalContent,
    RawDataAlertTip
} from "metabase/query_builder/components/AlertModals";
import Button from "metabase/components/Button";
import {
    CREATE_ALERT,
    FETCH_ALERTS_FOR_QUESTION,
} from "metabase/alert/alert";
import MetabaseCookies from "metabase/lib/cookies";
import Radio from "metabase/components/Radio";
import { getQuestionAlerts } from "metabase/query_builder/selectors";
import { FETCH_PULSE_FORM_INPUT } from "metabase/pulse/actions";
import ChannelSetupModal from "metabase/components/ChannelSetupModal";

describe("Alerts", () => {
    let rawDataQuestion = null;
    let timeSeriesQuestion = null;
    let timeSeriesQuestionWithGoal = null;
    let progressBarQuestion = null;

    beforeAll(async () => {
        useSharedAdminLogin()

        rawDataQuestion = await createSavedQuestion(
            Question.create({databaseId: 1, tableId: 1, metadata: null})
                .setDisplayName("Just raw, untamed data")
        )

        timeSeriesQuestion = await createSavedQuestion(
            Question.create({databaseId: 1, tableId: 1, metadata: null})
                .query()
                .addAggregation(["count"])
                .addBreakout(["datetime-field", ["field-id", 1], "day"])
                .question()
                .setDisplay("line")
                .setDisplayName("Time series line")
        )

        timeSeriesQuestionWithGoal = await createSavedQuestion(
            Question.create({databaseId: 1, tableId: 1, metadata: null})
                .query()
                .addAggregation(["count"])
                .addBreakout(["datetime-field", ["field-id", 1], "day"])
                .question()
                .setDisplay("line")
                .setVisualizationSettings({ "graph.show_goal": true, "graph.goal_value": 10 })
                .setDisplayName("Time series line with goal")
        )

        progressBarQuestion = await createSavedQuestion(
            Question.create({databaseId: 1, tableId: 1, metadata: null})
                .query()
                .addAggregation(["count"])
                .question()
                .setDisplay("progress")
                .setVisualizationSettings({ "progress.goal": 50 })
                .setDisplayName("Progress bar question")
        )
    })

    afterAll(async () => {
        await CardApi.delete({cardId: rawDataQuestion.id()})
        await CardApi.delete({cardId: timeSeriesQuestion.id()})
        await CardApi.delete({cardId: timeSeriesQuestionWithGoal.id()})
        await CardApi.delete({cardId: progressBarQuestion.id()})
    })

    describe("missing email/slack credentials", () => {
        it("should prompt you to add email/slack credentials", async () => {
            await forBothAdminsAndNormalUsers(async () => {
                MetabaseCookies.getHasSeenAlertSplash = () => false

                const store = await createTestStore()
                store.pushPath(Urls.question(rawDataQuestion.id()))
                const app = mount(store.getAppContainer());

                await store.waitForActions([INITIALIZE_QB, QUERY_COMPLETED, FETCH_ALERTS_FOR_QUESTION])

                const actionsMenu = app.find(QueryHeader).find(EntityMenu)
                click(actionsMenu.childAt(0))

                const alertsMenuItem = actionsMenu.find(Icon).filterWhere(i => i.prop("name") === "alert")
                click(alertsMenuItem)

                await store.waitForActions([FETCH_PULSE_FORM_INPUT])
                const alertModal = app.find(QueryHeader).find(".test-modal")
                expect(alertModal.find(ChannelSetupModal).length).toBe(1)
            })
        })
    })

    describe("with only slack set", () => {
        const normalFormInput = PulseApi.form_input
        beforeAll(async () => {
            const formInput = await PulseApi.form_input()
            PulseApi.form_input = () => ({
                channels: {
                ...formInput.channels,
                    "slack": {
                        ...formInput.channels.slack,
                        "configured": true
                    }
                }
            })
        })
        afterAll(() => {
            PulseApi.form_input = normalFormInput
        })

        it("should let admins create alerts", async () => {
            useSharedAdminLogin()
            const store = await createTestStore()
            store.pushPath(Urls.question(rawDataQuestion.id()))
            const app = mount(store.getAppContainer());

            await store.waitForActions([INITIALIZE_QB, QUERY_COMPLETED, FETCH_ALERTS_FOR_QUESTION])

            const actionsMenu = app.find(QueryHeader).find(EntityMenu)
            click(actionsMenu.childAt(0))

            const alertsMenuItem = actionsMenu.find(Icon).filterWhere(i => i.prop("name") === "alert")
            click(alertsMenuItem)

            await store.waitForActions([FETCH_PULSE_FORM_INPUT])
            const alertModal = app.find(QueryHeader).find(".test-modal")
            expect(alertModal.find(ChannelSetupModal).length).toBe(0)
            expect(alertModal.find(AlertEducationalScreen).length).toBe(1)
        })

        it("should say to non-admins that admin must add email credentials", async () => {
            useSharedNormalLogin()
            const store = await createTestStore()
            store.pushPath(Urls.question(rawDataQuestion.id()))
            const app = mount(store.getAppContainer());

            await store.waitForActions([INITIALIZE_QB, QUERY_COMPLETED, FETCH_ALERTS_FOR_QUESTION])

            const actionsMenu = app.find(QueryHeader).find(EntityMenu)
            click(actionsMenu.childAt(0))

            const alertsMenuItem = actionsMenu.find(Icon).filterWhere(i => i.prop("name") === "alert")
            click(alertsMenuItem)

            await store.waitForActions([FETCH_PULSE_FORM_INPUT])
            const alertModal = app.find(QueryHeader).find(".test-modal")
            expect(alertModal.find(ChannelSetupModal).length).toBe(1)
            expect(alertModal.find(ChannelSetupModal).prop("channels")).toEqual(["email"])
        })
    })

    describe("alert creation", () => {
        const normalFormInput = PulseApi.form_input
        beforeAll(async () => {
            // all channels configured
            const formInput = await PulseApi.form_input()
            PulseApi.form_input = () => ({
                channels: {
                    ...formInput.channels,
                    "email": {
                        ...formInput.channels.email,
                        configured: true
                    },
                    "slack": {
                        ...formInput.channels.slack,
                        configured: true
                    }
                }
            })
        })
        afterAll(async () => {
            PulseApi.form_input = normalFormInput

            // remove all created alerts
            const alerts = await AlertApi.list()
            await Promise.all(alerts.map((alert) => AlertApi.delete({ id: alert.id })))
        })

        it("should show you the first time educational screen", async () => {
            await forBothAdminsAndNormalUsers(async () => {
                MetabaseCookies.getHasSeenAlertSplash = () => false

                const store = await createTestStore()
                store.pushPath(Urls.question(rawDataQuestion.id()))
                const app = mount(store.getAppContainer());

                await store.waitForActions([INITIALIZE_QB, QUERY_COMPLETED, FETCH_ALERTS_FOR_QUESTION])

                const actionsMenu = app.find(QueryHeader).find(EntityMenu)
                click(actionsMenu.childAt(0))

                const alertsMenuItem = actionsMenu.find(Icon).filterWhere(i => i.prop("name") === "alert")
                click(alertsMenuItem)

                await store.waitForActions([FETCH_PULSE_FORM_INPUT])
                const alertModal = app.find(QueryHeader).find(".test-modal")
                const educationalScreen = alertModal.find(AlertEducationalScreen)

                clickButton(educationalScreen.find(Button))
                const creationScreen = alertModal.find(CreateAlertModalContent)
                expect(creationScreen.length).toBe(1)
            })
        });

        describe("for non-admins", () => {
            beforeAll(() => {
                useSharedNormalLogin()
            })

            it("should support 'rows present' alert for raw data questions", async () => {
                MetabaseCookies.getHasSeenAlertSplash = () => true

                const store = await createTestStore()
                store.pushPath(Urls.question(rawDataQuestion.id()))
                const app = mount(store.getAppContainer());

                await store.waitForActions([INITIALIZE_QB, QUERY_COMPLETED, FETCH_ALERTS_FOR_QUESTION])

                const actionsMenu = app.find(QueryHeader).find(EntityMenu)
                click(actionsMenu.childAt(0))

                const alertsMenuItem = actionsMenu.find(Icon).filterWhere(i => i.prop("name") === "alert")
                click(alertsMenuItem)

                await store.waitForActions([FETCH_PULSE_FORM_INPUT])
                const alertModal = app.find(QueryHeader).find(".test-modal")
                const creationScreen = alertModal.find(CreateAlertModalContent)
                expect(creationScreen.find(RawDataAlertTip).length).toBe(1)
                expect(creationScreen.find(AlertSettingToggle).length).toBe(0)

                clickButton(creationScreen.find(".Button.Button--primary"))
                await store.waitForActions([CREATE_ALERT])
            })

            it("should support 'rows present' alert for timeseries questions without a goal", async () => {
                MetabaseCookies.getHasSeenAlertSplash = () => true

                const store = await createTestStore()
                store.pushPath(Urls.question(timeSeriesQuestion.id()))
                const app = mount(store.getAppContainer());

                await store.waitForActions([INITIALIZE_QB, QUERY_COMPLETED, FETCH_ALERTS_FOR_QUESTION])

                const actionsMenu = app.find(QueryHeader).find(EntityMenu)
                click(actionsMenu.childAt(0))

                const alertsMenuItem = actionsMenu.find(Icon).filterWhere(i => i.prop("name") === "alert")
                click(alertsMenuItem)

                await store.waitForActions([FETCH_PULSE_FORM_INPUT])
                const alertModal = app.find(QueryHeader).find(".test-modal")
                const creationScreen = alertModal.find(CreateAlertModalContent)
                expect(creationScreen.find(RawDataAlertTip).length).toBe(1)
                expect(creationScreen.find(AlertSettingToggle).length).toBe(0)
            })

            it("should work for timeseries questions with a set goal", async () => {
                MetabaseCookies.getHasSeenAlertSplash = () => true

                const store = await createTestStore()
                store.pushPath(Urls.question(timeSeriesQuestionWithGoal.id()))
                const app = mount(store.getAppContainer());

                await store.waitForActions([INITIALIZE_QB, QUERY_COMPLETED, FETCH_ALERTS_FOR_QUESTION])
                await delay(500);

                const actionsMenu = app.find(QueryHeader).find(EntityMenu)
                click(actionsMenu.childAt(0))

                const alertsMenuItem = actionsMenu.find(Icon).filterWhere(i => i.prop("name") === "alert")
                click(alertsMenuItem)

                await store.waitForActions([FETCH_PULSE_FORM_INPUT])
                const alertModal = app.find(QueryHeader).find(".test-modal")
                expect(alertModal.find(AlertEducationalScreen).length).toBe(0)

                const creationScreen = alertModal.find(CreateAlertModalContent)
                expect(creationScreen.find(RawDataAlertTip).length).toBe(0)

                const toggles = creationScreen.find(AlertSettingToggle)
                expect(toggles.length).toBe(2)

                const aboveGoalToggle = toggles.at(0)
                expect(aboveGoalToggle.find(Radio).prop("value")).toBe(true)
                click(aboveGoalToggle.find("li").last())
                expect(aboveGoalToggle.find(Radio).prop("value")).toBe(false)

                const firstOnlyToggle = toggles.at(1)
                expect(firstOnlyToggle.find(Radio).prop("value")).toBe(true)

                click(creationScreen.find(".Button.Button--primary"))
                await store.waitForActions([CREATE_ALERT])

                const alert = Object.values(getQuestionAlerts(store.getState()))[0]
                expect(alert.alert_above_goal).toBe(false)
                expect(alert.alert_first_only).toBe(true)
            })
        })
    })

    describe("alert list", () => {
        beforeAll(() => {
            useSharedNormalLogin()
        })

        it("should let you see all created alerts", () => {

        })
    })
})