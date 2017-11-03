(ns metabase.pulse
  "Public API for sending Pulses."
  (:require [clojure.tools.logging :as log]
            [metabase
             [driver :as driver]
             [email :as email]
             [query-processor :as qp]
             [util :as u]]
            [metabase.email.messages :as messages]
            [metabase.integrations.slack :as slack]
            [metabase.models
             [card :refer [Card]]
             [pulse :refer [Pulse]]]
            [metabase.pulse.render :as render]
            [metabase.util.urls :as urls]
            [schema.core :as s]
            [toucan.db :as db])
  (:import java.util.TimeZone))

;;; ## ---------------------------------------- PULSE SENDING ----------------------------------------


;; TODO: this is probably something that could live somewhere else and just be reused
(defn execute-card
  "Execute the query for a single card with CARD-ID. OPTIONS are passed along to `dataset-query`."
  [card-id & {:as options}]
  {:pre [(integer? card-id)]}
  (when-let [card (Card :id card-id, :archived false)]
    (let [{:keys [creator_id dataset_query]} card]
      (try
        {:card   card
         :result (qp/process-query-and-save-execution! dataset_query
                   (merge {:executed-by creator_id, :context :pulse, :card-id card-id}
                          options))}
        (catch Throwable t
          (log/warn (format "Error running card query (%n)" card-id) t))))))

(defn- database-id [card]
  (or (:database_id card)
      (get-in card [:dataset_query :database])))

(s/defn defaulted-timezone :- TimeZone
  "Returns the timezone for the given `CARD`. Either the report
  timezone (if applicable) or the JVM timezone."
  [card :- Card]
  (let [^String timezone-str (or (some-> card database-id driver/database-id->driver driver/report-timezone-if-supported)
                                 (System/getProperty "user.timezone"))]
    (TimeZone/getTimeZone timezone-str)))

(defn- create-pulse-notification [{:keys [id name] :as pulse} results recipients]
  (log/debug (format "Sending Pulse (%d: %s) via Channel :email" id name))
  (let [email-subject    (str "Pulse: " name)
        email-recipients (filterv u/is-email? (map :email recipients))
        timezone         (-> results first :card defaulted-timezone)]
    {:subject      email-subject
     :recipients   email-recipients
     :message-type :attachments
     :message      (messages/render-pulse-email timezone pulse results)}))

(defn- create-alert-notification [{:keys [id name] :as pulse} results recipients]
  (log/debug (format "Sending Pulse (%d: %s) via Channel :email" id name))
  (let [email-subject    (str "Alert: " name)
        email-recipients (filterv u/is-email? (map :email recipients))
        timezone         (-> results first :card defaulted-timezone)]
    {:subject      email-subject
     :recipients   email-recipients
     :message-type :attachments
     :message      (messages/render-alert-email timezone pulse results)}))

(defn- send-email-pulse!
  "Send a `Pulse` email given a list of card results to render and a list of recipients to send to."
  [{:keys [subject recipients message-type message]}]
  (email/send-message!
    :subject      subject
    :recipients   recipients
    :message-type message-type
    :message      message))

(defn- alert? [pulse]
  (boolean (:alert_condition pulse)))

(defn create-slack-attachment-data
  "Returns a seq of slack attachment data structures, used in `create-and-upload-slack-attachments!`"
  [card-results]
  (let [{channel-id :id} (slack/files-channel)]
    (for [{{card-id :id, card-name :name, :as card} :card, result :result} card-results]
      {:title      card-name
       :attachment-bytes-thunk (fn [] (render/render-pulse-card-to-png (defaulted-timezone card) card result))
       :title_link (urls/card-url card-id)
       :attachment-name "image.png"
       :channel-id channel-id
       :fallback   card-name})))

(defn- create-slack-alert-notification [pulse results channel-id]
  (log/debug (u/format-color 'cyan "Sending Alert (%d: %s) via Slack" (:id pulse) (:name pulse)))
  {:channel-id channel-id
   :message (str "Alert: " (:name pulse))
   :attachments (create-slack-attachment-data results)})

(defn- create-slack-pulse-notification [pulse results channel-id]
  (log/debug (u/format-color 'cyan "Sending Pulse (%d: %s) via Slack" (:id pulse) (:name pulse)))
  {:channel-id channel-id
   :message (str "Pulse: " (:name pulse))
   :attachments (create-slack-attachment-data results)})

(defn create-and-upload-slack-attachments!
  "Create an attachment in Slack for a given Card by rendering its result into an image and uploading it."
  [attachments]
  (doall
   (for [{:keys [attachment-bytes-thunk attachment-name channel-id] :as attachment-data} attachments]
     (let [slack-file-url (slack/upload-file! (attachment-bytes-thunk) attachment-name channel-id)]
       (-> attachment-data
           (select-keys [:title :title_link :fallback])
           (assoc :image_url slack-file-url))))))

(defn- send-slack-pulse!
  "Post a `Pulse` to a slack channel given a list of card results to render and details about the slack destination."
  [{:keys [channel-id message attachments]}]
  {:pre [(string? channel-id)]}
  (let [attachments (create-and-upload-slack-attachments! attachments)]
    (slack/post-chat-message! channel-id message attachments)))

(defn- is-card-empty?
  "Check if the card is empty"
  [card]
  (let [result (:result card)]
    (or (zero? (-> result :row_count))
        ;; Many aggregations result in [[nil]] if there are no rows to aggregate after filters
        (= [[nil]]
           (-> result :data :rows)))))

(defn- are-all-cards-empty?
  "Do none of the cards have any results?"
  [results]
  (every? is-card-empty? results))

(defn- send-notifications! [notifications]
  (doseq [notification notifications]
    (if (contains? notification :channel-id)
      (send-slack-pulse! notification)
      (send-email-pulse! notification))))

(defn- rows-alert? [pulse]
  (= "rows" (:alert_condition pulse)))

(defn- goal-alert? [pulse]
  (= "goal" (:alert_condition pulse)))

(defn- find-goal-value
  "The goal value can come from a progress goal or a graph goal_value depending on it's type"
  [result]
  (case (get-in result [:card :display])

    (:area :bar :line)
    (get-in result [:card :visualization_settings :graph.goal_value])

    :progress
    (get-in result [:card :visualization_settings :progress.goal])

    nil))

(defn- dimension-column?
  "A dimension column is any non-aggregation column"
  [col]
  (not= :aggregation (:source col)))

(defn- summable-column?
  "A summable column is any numeric column that isn't a special type like an FK or PK. It also excludes unix
  timestamps that are numbers, but with a special type of DateTime"
  [{:keys [base_type special_type]}]
  (and (or (isa? base_type :type/Number)
           (isa? special_type :type/Number))
       (not (isa? special_type :type/Special))
       (not (isa? special_type :type/DateTime))))

(defn- metric-column?
  "A metric column is any non-breakout column that is summable (numeric that isn't a special type like an FK/PK/Unix
  timestamp)"
  [col]
  (and (not= :breakout (:source col))
       (summable-column? col)))

(defn- default-goal-column-index
  "For graphs with goals, this function returns the index of the default column that should be used to compare against
  the goal. This follows the frontend code getDefaultLineAreaBarColumns closely with a slight change (detailed in the
  code)"
  [results]
  (let [graph-type (get-in results [:card :display])
        [col-1 col-2 col-3 :as all-cols] (get-in results [:result :data :cols])
        cols-count (count all-cols)]

    (cond
      ;; Progress goals return a single row and column, compare that
      (= :progress graph-type)
      0

      ;; Called DIMENSION_DIMENSION_METRIC in the UI, grab the metric third column for comparison
      (and (= cols-count 3)
           (dimension-column? col-1)
           (dimension-column? col-2)
           (metric-column? col-3))
      2

      ;; Called DIMENSION_METRIC in the UI, use the metric column for comparison
      (and (= cols-count 2)
           (dimension-column? col-1)
           (metric-column? col-2))
      1

      ;; Called DIMENSION_METRIC_METRIC in the UI, use the metric column for comparison. The UI returns all of the
      ;; metric columns here, but that causes an issue around which column the user intended to compare to the
      ;; goal. The below code always takes the first metric column, this might diverge from the UI
      (and (>= cols-count 3)
           (dimension-column? col-1)
           (every? metric-column? (rest all-cols)))
      1

      ;; If none of the above is true, return nil as we don't know what to compare the goal to
      :else nil)))

(defn- column-name->index [results ^String column-name]
  (when column-name
    (first (map-indexed (fn [idx column]
                          (when (.equalsIgnoreCase column-name (:name column))
                            idx))
                        (get-in results [:result :data :cols])))))

(defn- goal-comparison-column [result]
  (or (column-name->index result (get-in result [:card :visualization_settings :graph.metrics]))
      (default-goal-column-index result)))

(defn- goal-met? [{:keys [alert_above_goal] :as pulse} results]
  (let [first-result    (first results)
        goal-comparison (if alert_above_goal <= >=)
        comparison-col-index (goal-comparison-column first-result)
        goal-val (find-goal-value first-result)]

    (when-not (and goal-val comparison-col-index)
      (throw (Exception. (format (str "Unable to compare results to goal for alert. "
                                      "Question ID is '%s' with visualization settings '%s'")
                                 (get-in results [:card :id])
                                 (pr-str (get-in results [:card :visualization_settings]))))))

    (some (fn [row]
            (goal-comparison goal-val (nth row comparison-col-index)))
          (get-in first-result [:result :data :rows]))))

(defn- should-send-notification?
  [{:keys [alert_condition] :as pulse} results]
  (cond
    (and (alert? pulse)
         (rows-alert? pulse))
    (not (are-all-cards-empty? results))

    (and (alert? pulse)
         (goal-alert? pulse))
    (goal-met? pulse results)

    (and (not (alert? pulse))
         (:skip_if_empty pulse))
    (not (are-all-cards-empty? results))

    :else
    true))

(defn- pulse->notifications [{:keys [cards channel-ids], :as pulse}]
  (let [results     (for [card  cards
                          :let  [result (execute-card (:id card), :pulse-id (:id pulse))] ; Pulse ID may be `nil` if the Pulse isn't saved yet
                          :when result] ; some cards may return empty results, e.g. if the card has been archived
                      result)
        channel-ids (or channel-ids (mapv :id (:channels pulse)))]
    (when (should-send-notification? pulse results)

      (when  (:alert_first_only pulse)
        (db/delete! Pulse :id (:id pulse)))

      (for [channel-id channel-ids
            :let [{:keys [channel_type details recipients]} (some #(when (= channel-id (:id %)) %)
                                                                  (:channels pulse))]]
        (case (keyword channel_type)
          :email ((if (alert? pulse)
                    create-alert-notification
                    create-pulse-notification) pulse results recipients)
          :slack ((if (alert? pulse)
                    create-slack-alert-notification
                    create-slack-pulse-notification)
                  pulse results (:channel details)))))))

(defn send-pulse!
  "Execute and Send a `Pulse`, optionally specifying the specific `PulseChannels`.  This includes running each
   `PulseCard`, formatting the results, and sending the results to any specified destination.

   Example:
       (send-pulse! pulse)                       Send to all Channels
       (send-pulse! pulse :channel-ids [312])    Send only to Channel with :id = 312"
  [{:keys [cards], :as pulse} & {:keys [channel-ids]}]
  {:pre [(map? pulse) (every? map? cards) (every? :id cards)]}
  (send-notifications! (pulse->notifications (merge pulse (when channel-ids {:channel-ids channel-ids})))))
