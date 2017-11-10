/* @flow */

import React, { Component } from "react";
import styles from "./Text.css";

import cx from "classnames";

import type { VisualizationProps } from "metabase/meta/types/Visualization";

export default class Text extends Component {
    props: VisualizationProps;

    static uiName = "Text";
    static identifier = "text";
    static iconName = "text";

    static noHeader = true;
    static supportsSeries = true;

    static minSize = { width: 3, height: 3 };

    static checkRenderable([{ data: { cols, rows} }]) {
        // text can always be rendered, nothing needed here
    }

    static settings = {

    };

    render() {
        let { series: [{ card, data: { cols, rows }}], className, actionButtons, gridSize, settings, onChangeCardAndRun, visualizationIsClickable, onVisualizationClick } = this.props;
        let isSmall = gridSize && gridSize.width < 4;

        return (
            <div className={cx(className, styles.Text, styles[isSmall ? "small" : "large"])}>
                <h2>TEXT</h2>
            </div>
        );
    }
}
