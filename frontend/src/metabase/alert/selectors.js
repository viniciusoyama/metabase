export const getAlerts = (state) => state.alert.alerts.result

// A shared error selector for all errors produced by alert CRUD operations
export const getAlertError = (state) => state.alert.alerts.error